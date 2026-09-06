const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const busboy = require('busboy');
require('dotenv').config();

const { extractEpicDetails, uploadStreamToGemini, uploadCache } = require('./geminiService');

const app = express();
const port = process.env.PORT || 3000;


app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map(o => o.trim());

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (Postman, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // Allow requests from local network devices (e.g. phones on WiFi)
        if (origin.startsWith('http://192.168.') || origin.startsWith('http://10.')) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    }
}));

const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Please wait a minute before trying again.' }
});
app.use('/api/', limiter);

const EPIC_REGEX = /^[A-Z]{3}\d{7}$/;

app.post('/api/search-epic', async (req, res) => {
    const startTime = Date.now();

    //  Global request timeout (5 minutes max)
    const TIMEOUT_MS = 5 * 60 * 1000;
    const timeoutId = setTimeout(() => {
        if (!res.headersSent) {
            console.error('⏰ Request timed out after 5 minutes.');
            res.status(504).json({ success: false, error: 'Request timed out. Please try again with fewer files.' });
        }
    }, TIMEOUT_MS);

    try {
        //  Validate Content-Type before parsing
        const contentType = req.headers['content-type'] || '';
        if (!contentType.startsWith('multipart/')) {
            clearTimeout(timeoutId);
            return res.status(415).json({ error: 'Invalid content type. Please send multipart/form-data.' });
        }

        const bb = busboy({ 
            headers: req.headers,
            limits: { 
                files: 10, // Max 10 files
                fileSize: 100 * 1024 * 1024 // Max 100MB per file
            }
        });
        let epicNumber = null;
        let geminiFiles = [];
        let uploadPromises = [];
        let fileSizeLimitHit = false;
        
        const bbPromise = new Promise((resolve, reject) => {
            bb.on('field', (name, val) => {
                if (name === 'epic_number') epicNumber = val;
            });
            
            bb.on('file', (name, file, info) => {
                if (info.mimeType !== 'application/pdf') {
                    console.log(`Rejected non-PDF file: ${info.filename}`);
                    file.resume(); // Discard the stream immediately
                    return; // Ignore this file
                }
                
                const originalName = info.filename;
                
                // Track if a single file exceeds the size limit
                file.on('limit', () => {
                    console.log(`File ${originalName} exceeds 100MB size limit.`);
                    fileSizeLimitHit = true;
                });

                if (uploadCache.has(originalName)) {
                    console.log(`Fast-path: Reusing already uploaded file for ${originalName}`);
                    geminiFiles.push(uploadCache.get(originalName));
                    file.resume(); // Discard the local stream immediately (zero RAM)
                } else {
                    console.log(`Streaming file: ${originalName} directly to Gemini API...`);
                    const promise = uploadStreamToGemini(file, info.mimeType, info.filename)
                        .then(uploaded => {
                            geminiFiles.push(uploaded);
                            uploadCache.set(originalName, uploaded);
                        })
                        .catch(err => {
                            file.resume(); // Ensure stream is consumed if upload fails
                            throw err;
                        });
                    uploadPromises.push(promise);
                }
            });
            
            bb.on('close', async () => {
                try {
                    await Promise.all(uploadPromises);
                    resolve();
                } catch(e) {
                    reject(e);
                }
            });
            
            bb.on('error', reject);
            
            bb.on('filesLimit', () => {
                console.log('Files limit exceeded.');
                reject(new Error('LIMIT_FILE_COUNT'));
            });

            req.on('aborted', () => {
                console.log('Client aborted the request.');
                reject(new Error('CLIENT_ABORTED'));
            });
        });

        // Start reading the multipart stream from the client
        req.pipe(bb);
        
        // Wait until the entire stream is piped to Gemini
        await bbPromise;

        // Check if any file hit the size limit
        if (fileSizeLimitHit) {
            clearTimeout(timeoutId);
            return res.status(413).json({ error: 'One or more files exceed the 100MB size limit.' });
        }
        
        if (!epicNumber) {
            clearTimeout(timeoutId);
            return res.status(400).json({ error: 'Please provide an epic_number in the form data.' });
        }
        
        const trimmedEpic = epicNumber.trim();
        
        if (trimmedEpic.length !== 10) {
            clearTimeout(timeoutId);
            return res.status(400).json({ error: 'EPIC number must be exactly 10 characters long.' });
        }

        //  Strict EPIC format validation
        if (!EPIC_REGEX.test(trimmedEpic)) {
            clearTimeout(timeoutId);
            return res.status(400).json({ error: 'Invalid EPIC number format. It must be 3 uppercase letters followed by 7 digits (e.g., FCS3644630).' });
        }
        
        if (geminiFiles.length === 0) {
            clearTimeout(timeoutId);
            return res.status(400).json({ error: 'Please upload at least one PDF file.' });
        }
        
        console.log(`Starting PARALLEL OCR extraction for EPIC: ${trimmedEpic} across ${geminiFiles.length} files`);

        // Call the Gemini service with the array of files
        const result = await extractEpicDetails(geminiFiles, trimmedEpic);

        clearTimeout(timeoutId);

        const timeTakenMs = Date.now() - startTime;
        console.log(`⏱️ Total time taken: ${(timeTakenMs / 1000).toFixed(2)} seconds`);

        res.json({ success: true, data: result, timeTakenSeconds: (timeTakenMs / 1000).toFixed(2) });
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('Error processing request:', error);
        
        let statusCode = 500;
        //  Never leak raw error.message to the client for unknown errors
        let errorMessage = 'An unexpected error occurred. Please try again.';

        if (error.message === 'LIMIT_FILE_COUNT') {
            statusCode = 413;
            errorMessage = 'Too many files uploaded. Maximum is 10.';
        } else if (error.message === 'CLIENT_ABORTED') {
            statusCode = 499;
            errorMessage = 'Request was aborted by the client.';
        } else if (error.message && error.message.includes('All models failed after multiple retries')) {
            statusCode = 503;
            errorMessage = 'Servers are currently overloaded. Please try again in a few minutes.';
        } else if (error.message === 'Not allowed by CORS') {
            statusCode = 403;
            errorMessage = 'This origin is not allowed to access this API.';
        }

        if (!res.headersSent) {
            res.status(statusCode).json({ success: false, error: errorMessage });
        }
    }
});

app.listen(port, () => {
    console.log(`Voter ID API listening at http://localhost:${port}`);
});

// Keep the event loop alive
setInterval(() => {}, 1000 * 60 * 60);

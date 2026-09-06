const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');
const { LRUCache } = require('lru-cache');

// Initialize Gemini API clients
const apiKey = process.env.GEMINI_API_KEY;
let genAI = null;
let fileManager = null;

if (apiKey) {
    genAI = new GoogleGenerativeAI(apiKey);
    fileManager = new GoogleAIFileManager(apiKey);
}

// Fix #6: LRU cache with max 100 entries to prevent unbounded memory growth
const uploadCache = new LRUCache({ max: 100 });

/**
 * Streams a file directly to Gemini's Resumable Upload API
 */
async function uploadStreamToGemini(fileStream, mimeType, displayName) {
    if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not set.");
    
    console.log(`Initiating stream upload to Gemini for ${displayName}...`);
    
    // 1. Initiate resumable upload
    // Fix #2: API key in header instead of URL query parameter
    const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Type': mimeType
        },
        body: JSON.stringify({ file: { displayName } })
    });
    
    if (!initRes.ok) {
        throw new Error(`Failed to initialize upload: ${await initRes.text()}`);
    }
    
    const uploadUrl = initRes.headers.get('x-goog-upload-url');
    console.log('Got upload URL, streaming file chunks directly to Gemini...');
    
    // 2. Upload the stream chunks
    const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': '0'
        },
        body: fileStream,
        duplex: 'half'
    });
    
    if (!uploadRes.ok) {
        throw new Error(`Failed to upload file stream: ${await uploadRes.text()}`);
    }
    
    const result = await uploadRes.json();
    console.log(`Stream uploaded successfully as: ${result.file.name}`);
    
    // 3. Wait for Google to process the PDF for text extraction
    console.log("Waiting for Gemini to process the uploaded file...");
    let fileState = await fileManager.getFile(result.file.name);
    while (fileState.state === FileState.PROCESSING) {
        console.log('File is still processing on Google side, waiting 2 seconds...');
        await new Promise((resolve) => setTimeout(resolve, 2000));
        fileState = await fileManager.getFile(result.file.name);
    }
    
    if (fileState.state === FileState.FAILED) {
        throw new Error("PDF processing failed on Gemini's side.");
    }
    
    console.log("Streamed file is ready for OCR generation.");
    return fileState;
}

/**
 * Internal function to search a single file for the Parallel Accelerator
 */
async function searchSingleFile(geminiFile, epicNumber, fileIndex, totalFiles, prompt, fallbackModels, signal) {
    console.log(`[Search ${fileIndex + 1}/${totalFiles}] Asking Gemini to find EPIC ${epicNumber} in ${geminiFile.displayName}...`);
    
    let result;
    let lastError;
    let cycleRetries = 3;
    let delay = 5000;

    for (let cycle = 0; cycle < cycleRetries; cycle++) {
        let cycleSuccess = false;
        for (const currentModelName of fallbackModels) {
            if (signal && signal.aborted) {
                console.log(`  -> [File ${fileIndex + 1}] Search cancelled because EPIC was found in another file.`);
                throw new Error('Search aborted');
            }
            
            console.log(`  -> [File ${fileIndex + 1}] Attempting with model: ${currentModelName}`);
            const model = genAI.getGenerativeModel({ model: currentModelName });
            
            try {
                // Pass the abort signal to the API request
                result = await model.generateContent([
                    {
                        fileData: {
                            mimeType: geminiFile.mimeType,
                            fileUri: geminiFile.uri
                        }
                    },
                    { text: prompt }
                ], { signal });
                console.log(`  -> [File ${fileIndex + 1}] Success with model: ${currentModelName}`);
                cycleSuccess = true;
                break; // Success, exit inner loop
            } catch (error) {
                lastError = error;
                if (error.message && (error.message.includes('503') || error.message.includes('429'))) {
                    console.log(`  -> [File ${fileIndex + 1}] Model ${currentModelName} is busy.`);
                    continue; // Try the next model immediately
                } else if (error.message && error.message.includes('404')) {
                     console.log(`  -> [File ${fileIndex + 1}] Model ${currentModelName} is unavailable (404). Skipping...`);
                     continue; // Try next model immediately
                } else {
                    throw error; // Rethrow if it's a different error (like 400 Bad Request)
                }
            }
        }
        
        if (cycleSuccess) break; // Exit outer loop if we got a result
        
        if (cycle < cycleRetries - 1) {
            console.log(`  -> [File ${fileIndex + 1}] All models busy. Waiting ${delay/1000}s before next cycle...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // exponential backoff
        }
    }
    
    if (!result) {
        throw new Error(`[File ${fileIndex + 1}] All models failed after multiple retries due to high demand. Last error: ${lastError.message}`);
    }
    
    let textResult = result.response.text();
    
    // Extract JSON part from the response
    let jsonPart = textResult;
    const jsonMatch = textResult.match(/JSON:\s*([\s\S]*)/i);
    if (jsonMatch && jsonMatch[1]) {
        jsonPart = jsonMatch[1];
    }
    
    // Clean up Markdown JSON formatting or extra text
    const markdownMatch = jsonPart.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch && markdownMatch[1]) {
        jsonPart = markdownMatch[1];
    } else {
        // Fallback: extract everything from the first { to the last }
        const firstBrace = jsonPart.indexOf('{');
        const lastBrace = jsonPart.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            jsonPart = jsonPart.substring(firstBrace, lastBrace + 1);
        }
    }
    
    jsonPart = jsonPart.trim();
    
    // Parse the JSON
    try {
        const parsedData = JSON.parse(jsonPart);
        
        // If the EPIC was found in this file, RESOLVE so Promise.any catches it instantly!
        if (parsedData.found !== false) {
            console.log(`✅ SUCCESS! Found EPIC ${epicNumber} in file ${geminiFile.displayName}. Resolving Promise.any!`);
            return parsedData;
        }
        
        console.log(`❌ EPIC not found in ${geminiFile.displayName}. Rejecting so Promise.any moves on.`);
        throw new Error('Not found in this file');
        
    } catch (e) {
        // If it fails to parse, or if found === false (which throws above), we reject this specific promise.
        throw new Error('Not found or parse failed');
    }
}

/**
 * Extracts voter details for a given EPIC number from an array of already-uploaded Gemini files using Parallel Search
 */
async function extractEpicDetails(geminiFiles, epicNumber) {
    if (!apiKey || !genAI || !fileManager) {
        throw new Error("GEMINI_API_KEY environment variable is not set.");
    }
    
    // Ensure we are working with an array
    const filesToSearch = Array.isArray(geminiFiles) ? geminiFiles : [geminiFiles];

    // 2. Prepare the prompt
    const prompt = `You are an expert OCR parser for Indian Electoral Rolls. 
The uploaded PDF contains pages with grids of rectangular voter boxes.

Your task is to find the exact voter box that contains the EPIC Number: "${epicNumber}".
*NOTE: OCR is not perfect. The EPIC number might have slight errors in the text like 'O' instead of '0', or include spaces (e.g., "SIQ 754 6070" or "SIQ7546O70").*

Important Layout Rules:
1. The EPIC number (e.g. "${epicNumber}") is printed in the top-right corner of the voter's box.
2. The serial number is printed in a small box in the top-left corner of the SAME voter's box.
3. The voter's details (Name, Father's/Husband's Name, House Number, Age, Gender) are written inside this EXACT SAME box, below the serial and EPIC numbers.

CRITICAL: Do NOT hallucinate. Do not return details of a different person. Only return details if you find the exact string "${epicNumber}".

To ensure accuracy, follow these steps carefully:
Step 1: Search the entire document for the exact string "${epicNumber}".
Step 2: Read the contents of the exact rectangular box that contains this string.
Step 3: Output the raw text of that box to prove you found it.
Step 4: Output the extracted details in JSON format.

Output Format:
RAW_TEXT: 
[Paste the exact raw text of the box you found here]

JSON:
{
  "epicNumber": "the epic number",
  "name": "voter name",
  "relativeName": "relative name",
  "relationType": "Father or Husband",
  "houseNumber": "house number",
  "age": 25,
  "gender": "gender",
  "partNumber": "part number if available",
  "pageNumber": "page number"
}

If the EPIC number is not found in the entire document, return this JSON:
{
  "found": false,
  "epicNumber": "${epicNumber}"
}
`;

    const fallbackModels = [
        process.env.GEMINI_MODEL || "gemini-flash-latest",
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.1-flash" // Removed 2.5 since it threw 404
    ];

    console.log(`🚀 Launching PARALLEL SEARCH across ${filesToSearch.length} PDFs for EPIC: ${epicNumber}...`);

    // Create an AbortController to stop background searches once we find the EPIC
    const abortController = new AbortController();

    // Map each file to a searchSingleFile Promise
    const searchPromises = filesToSearch.map((geminiFile, index) => {
        return searchSingleFile(geminiFile, epicNumber, index, filesToSearch.length, prompt, fallbackModels, abortController.signal);
    });

    try {
        // Promise.any will resolve INSTANTLY when the FIRST promise successfully returns the EPIC data!
        const foundData = await Promise.any(searchPromises);
        
        // Instantly cancel all the other 9 background requests that are still running!
        console.log(`🛑 Stopping all other parallel searches to save tokens...`);
        abortController.abort();
        
        return foundData;
    } catch (aggregateError) {
        // AggregateError is thrown ONLY if ALL promises reject (meaning the EPIC wasn't found in ANY PDF).
        console.log(`EPIC ${epicNumber} was not found in any of the provided PDFs after searching all in parallel.`);
        return {
            found: false,
            epicNumber: epicNumber
        };
    }
}

module.exports = {
    extractEpicDetails,
    uploadStreamToGemini,
    uploadCache
};

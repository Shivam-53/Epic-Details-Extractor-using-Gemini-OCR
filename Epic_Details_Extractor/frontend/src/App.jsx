import React, { useState, useRef } from 'react';
import { UploadCloud, Search, CheckCircle, FileText, Loader2, AlertCircle, ChevronDown, ChevronUp, Info, ExternalLink, Shield } from 'lucide-react';
import { Analytics } from '@vercel/analytics/react';
import { track } from '@vercel/analytics';
import './index.css';

function App() {
  const [showGuide, setShowGuide] = useState(false);
  const [epicNumber, setEpicNumber] = useState('');
  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFiles = Array.from(e.dataTransfer.files);
      const validFiles = droppedFiles.filter(f => f.type === 'application/pdf');
      
      if (validFiles.length > 10) {
        setError('You can only upload a maximum of 10 PDF files at once.');
        return;
      }
      
      if (validFiles.length > 0) {
        setFiles(validFiles);
        setError(null);
      } else {
        setError('Please upload PDF files only.');
      }
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      if (e.target.files.length > 10) {
        setError('You can only upload a maximum of 10 PDF files at once.');
        return;
      }
      setFiles(Array.from(e.target.files));
      setError(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (files.length === 0) {
      setError('Please select at least one PDF file.');
      return;
    }
    
    if (files.length > 10) {
      setError('You can only upload a maximum of 10 PDF files at once.');
      return;
    }
    
    const trimmedEpic = epicNumber.trim();
    if (!trimmedEpic) {
      setError('Please enter an EPIC number.');
      return;
    }
    
    if (trimmedEpic.length !== 10) {
      setError('EPIC number must be exactly 10 characters long.');
      return;
    }

    if (!/^[A-Z]{3}\d{7}$/.test(trimmedEpic)) {
      setError('Invalid EPIC format. Must be 3 letters followed by 7 digits (e.g., FCS3644630).');
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    files.forEach(f => formData.append('pdf', f));
    formData.append('epic_number', trimmedEpic);
    
    const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:3001`;  

    try {
      const response = await fetch(`${API_URL}/api/search-epic`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to process the document.');
      }

      setResult(data);
      
      if (data.success && data.data && data.data.found !== false) {
        track('Search Success');
      } else {
        track('Search Not Found');
      }
      
    } catch (err) {
      setError(err.message || 'An error occurred while connecting to the server.');
      track('Search Error', { error: err.message || 'Unknown error' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Maharashtra Draft Roll Search</h1>
        <p>Search your name in the Draft SIR Electoral Rolls (2026)</p>
      </div>

      <div className="context-banner">
        <Info size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
        <p>
          The Maharashtra Draft SIR released on 31st August 2026 is <strong>not searchable</strong>. 
          The PDF files downloaded from the ECI website do not support text search. 
          This tool exists for the convenience of the People of Maharashtra — just upload your PDFs and let us find your name using AI.
        </p>
      </div>

      <div className="guide-section">
        <button 
          type="button" 
          className="guide-toggle"
          onClick={() => setShowGuide(!showGuide)}
        >
          <span>How to use this tool</span>
          {showGuide ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {showGuide && (
          <div className="guide-content">
            <div className="guide-step">
              <span className="step-number">1</span>
              <div>
                Go to{' '}
                <a href="https://voters.eci.gov.in/download-eroll?stateCode=S13" target="_blank" rel="noopener noreferrer">
                  ECI Electoral Roll Download
                  <ExternalLink size={12} style={{ marginLeft: '4px', verticalAlign: 'middle' }} />
                </a>
              </div>
            </div>
            <div className="guide-step">
              <span className="step-number">2</span>
              <div>Select your <strong>District</strong></div>
            </div>
            <div className="guide-step">
              <span className="step-number">3</span>
              <div>Select your <strong>Assembly Constituency</strong></div>
            </div>
            <div className="guide-step">
              <span className="step-number">4</span>
              <div>Find your <strong>Part No.</strong> and <strong>Part Name</strong> (the place where you voted last time — a school, office, or community hall)</div>
            </div>
            <div className="guide-step">
              <span className="step-number">5</span>
              <div>If you <strong>remember your exact booth number</strong>, just download and upload that single booth's PDF. If your name is in it, we'll find it instantly.</div>
            </div>
            <div className="guide-step">
              <span className="step-number">6</span>
              <div>If you <strong>don't remember your booth number</strong>, download all the PDFs for your Part Name and upload them all here (up to 10 at a time). We'll search through every single one for you.</div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="epicNumber">EPIC Number</label>
            <input
              type="text"
              id="epicNumber"
              className="input-field"
              placeholder="e.g. FCS3644630"
              value={epicNumber}
              onChange={(e) => setEpicNumber(e.target.value.toUpperCase())}
              maxLength={10}
            />
          </div>

          <div className="form-group">
            <label>Electoral Roll (PDF)</label>
            <div 
              className={`file-drop-area ${isDragging ? 'active' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current.click()}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                accept="application/pdf"
                multiple
                style={{ display: 'none' }} 
              />
              {files.length > 0 ? (
                <>
                  <FileText size={48} />
                  <p>{files.length} PDF{files.length > 1 ? 's' : ''} selected</p>
                  <p style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem' }}>
                    Click or drag to replace
                  </p>
                </>
              ) : (
                <>
                  <UploadCloud size={48} />
                  <p>Drag & drop your PDFs here</p>
                  <p style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem' }}>
                    or click to browse files
                  </p>
                </>
              )}
            </div>
          </div>

          {error && (
            <div className="error-message">
              <AlertCircle size={16} style={{ display: 'inline', marginRight: '0.25rem', verticalAlign: 'text-bottom' }} />
              {error}
            </div>
          )}

          <button type="submit" className="btn" disabled={isLoading}>
            {isLoading ? (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                <Loader2 size={18} className="loading-spinner" style={{ marginBottom: 0 }} />
                Scanning Document...
              </span>
            ) : (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                <Search size={18} />
                Extract Data
              </span>
            )}
          </button>
        </form>

        <div className="privacy-badge">
          <Shield size={16} className="privacy-icon" />
          <p>
            <strong>Privacy Assured:</strong> Your PDFs are streamed securely to Google for temporary AI processing and are <strong>never stored, saved, or logged</strong> on our servers. We do not collect or retain any Personally Identifiable Information (PII).
          </p>
        </div>

        {isLoading && (
          <div className="loading-state">
             <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.875rem' }}>
               <Loader2 size={24} className="loading-spinner" style={{ margin: '0 auto 0.5rem', display: 'block' }} />
               <strong>Processing your request...</strong><br/>
               This may take up to 5 minutes depending on traffic and PDF size.<br/>
               Please do not close or refresh this page.
             </p>
          </div>
        )}

        {result && !isLoading && (
          <div className="results-card">
            {result.success && result.data && result.data.found !== false ? (
              <>
                <h2><CheckCircle size={20} color="#10b981" /> Voter Details Found</h2>
                <div className="result-row">
                  <span className="result-label">Name</span>
                  <span className="result-value">{result.data.name}</span>
                </div>
                <div className="result-row">
                  <span className="result-label">EPIC No.</span>
                  <span className="result-value">{result.data.epicNumber}</span>
                </div>
                <div className="result-row">
                  <span className="result-label">{result.data.relationType || 'Relative'}</span>
                  <span className="result-value">{result.data.relativeName}</span>
                </div>
                <div className="result-row">
                  <span className="result-label">Age / Gender</span>
                  <span className="result-value">{result.data.age} / {result.data.gender}</span>
                </div>
                <div className="result-row">
                  <span className="result-label">House No.</span>
                  <span className="result-value">{result.data.houseNumber}</span>
                </div>
                <div className="result-row">
                  <span className="result-label">Part / Page</span>
                  <span className="result-value">{result.data.partNumber} / {result.data.pageNumber}</span>
                </div>

                {result.timeTakenSeconds && (
                  <p style={{ textAlign: 'center', fontSize: '0.75rem', color: '#6b7280', marginTop: '1rem' }}>
                    ⚡ Search completed in {result.timeTakenSeconds}s
                  </p>
                )}
              </>
            ) : (
              <div style={{ textAlign: 'center', color: '#6b7280' }}>
                <AlertCircle size={32} style={{ margin: '0 auto 1rem', color: '#ef4444' }} />
                <p><strong>EPIC Number Not Found</strong></p>
                <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                  The EPIC number was not found in the uploaded document.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      <Analytics />
    </div>
  );
}

export default App;

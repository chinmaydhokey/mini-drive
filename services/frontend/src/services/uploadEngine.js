/**
 * uploadEngine.js — Resumable Chunked Upload Engine
 *
 * Slices large files in the browser, uploads chunks in parallel (3 concurrent),
 * supports pause/resume/cancel, automatic retry with exponential backoff,
 * CAS dedup integration, and optional client-side AES-256-GCM encryption.
 */

import { filesAPI } from './api';
import { sha256, encryptChunk, bytesToBase64 } from './cryptoEngine';

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
const DEFAULT_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000; // 1s, 2s, 4s exponential backoff

/**
 * @typedef {Object} UploadProgress
 * @property {string} fileId
 * @property {string} filename
 * @property {number} totalChunks
 * @property {number} uploadedChunks
 * @property {number} bytesUploaded
 * @property {number} bytesTotal
 * @property {number} speed - bytes/sec (rolling average)
 * @property {number} eta - estimated seconds remaining
 * @property {number} dedupedChunks
 * @property {number} dedupedBytes
 * @property {'idle'|'hashing'|'uploading'|'paused'|'completing'|'complete'|'error'|'cancelled'} status
 * @property {string|null} error
 */

export class ChunkedUploader {
  /**
   * @param {File} file - Browser File object
   * @param {Object} options
   * @param {string} [options.folderId]
   * @param {number} [options.concurrency=3]
   * @param {number} [options.chunkSize=4MB]
   * @param {function(UploadProgress):void} [options.onProgress]
   * @param {function(Object):void} [options.onComplete]
   * @param {function(string):void} [options.onError]
   * @param {boolean} [options.encrypt=false]
   * @param {CryptoKey} [options.encryptionKey]
   * @param {Uint8Array} [options.encryptionSalt]
   */
  constructor(file, options = {}) {
    this.file = file;
    this.folderId = options.folderId || null;
    this.concurrency = options.concurrency || DEFAULT_CONCURRENCY;
    this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.encrypt = options.encrypt || false;
    this.encryptionKey = options.encryptionKey || null;
    this.encryptionSalt = options.encryptionSalt || null;

    // Internal state
    this.fileId = null;
    this.totalChunks = Math.ceil(file.size / this.chunkSize);
    this.uploadedChunks = new Set();
    this.chunkHashes = new Array(this.totalChunks).fill(null);
    this.chunkIVs = new Array(this.totalChunks).fill(null);
    this.dedupedChunks = 0;
    this.dedupedBytes = 0;
    this.isPaused = false;
    this.isCancelled = false;
    this.status = 'idle';
    this.error = null;
    this.activeRequests = new Map(); // chunkIndex -> AbortController
    this.startTime = null;
    this.bytesUploaded = 0;
    this._speedSamples = []; // { time, bytes } for rolling speed calc
  }

  /**
   * Start or resume the upload.
   */
  async start() {
    if (this.isCancelled) return;

    try {
      this.isPaused = false;

      // Step 1: Initialize upload session (if not already)
      if (!this.fileId) {
        this.status = 'hashing';
        this._emitProgress();

        const initPayload = {
          filename: this.file.name,
          mimeType: this.file.type || 'application/octet-stream',
          size: this.file.size,
          totalChunks: this.totalChunks,
          folderId: this.folderId,
          isEncrypted: this.encrypt,
        };

        if (this.encrypt && this.encryptionSalt) {
          initPayload.encryptionSalt = bytesToBase64(this.encryptionSalt);
        }

        const { data } = await filesAPI.uploadInit(initPayload);
        this.fileId = data.data.fileId;
      }

      // Step 2: Check which chunks are already uploaded (for resume)
      if (this.uploadedChunks.size > 0 || this.status === 'paused') {
        try {
          const { data } = await filesAPI.uploadStatus(this.fileId);
          for (const idx of data.data.uploadedChunks) {
            this.uploadedChunks.add(idx);
          }
        } catch {
          // Fresh upload, no chunks uploaded yet
        }
      }

      // Step 3: Upload remaining chunks in parallel
      this.status = 'uploading';
      this.startTime = Date.now();
      this._emitProgress();

      const pendingIndices = [];
      for (let i = 0; i < this.totalChunks; i++) {
        if (!this.uploadedChunks.has(i)) {
          pendingIndices.push(i);
        }
      }

      // Process in batches of `concurrency`
      let idx = 0;
      const runBatch = async () => {
        const promises = [];
        while (idx < pendingIndices.length && promises.length < this.concurrency) {
          if (this.isPaused || this.isCancelled) break;
          const chunkIndex = pendingIndices[idx++];
          promises.push(this._uploadChunk(chunkIndex));
        }
        await Promise.all(promises);

        if (!this.isPaused && !this.isCancelled && idx < pendingIndices.length) {
          await runBatch();
        }
      };

      await runBatch();

      if (this.isCancelled) return;
      if (this.isPaused) {
        this.status = 'paused';
        this._emitProgress();
        return;
      }

      // Step 4: Complete upload
      this.status = 'completing';
      this._emitProgress();

      const completePayload = { fileId: this.fileId };
      if (this.encrypt) {
        completePayload.chunkIVs = this.chunkIVs.map(iv =>
          iv ? bytesToBase64(iv) : null
        );
      }

      const { data: completeData } = await filesAPI.uploadComplete(completePayload);

      this.status = 'complete';
      this._emitProgress();
      this.onComplete(completeData.data);
    } catch (err) {
      if (this.isCancelled) return;
      this.status = 'error';
      this.error = err.response?.data?.error?.message || err.message || 'Upload failed';
      this._emitProgress();
      this.onError(this.error);
    }
  }

  /**
   * Pause the upload. In-flight chunks will finish, but no new ones start.
   */
  pause() {
    this.isPaused = true;
    this.status = 'paused';
    this._emitProgress();
  }

  /**
   * Resume a paused upload.
   */
  async resume() {
    if (this.status !== 'paused' && this.status !== 'error') return;
    this.error = null;
    await this.start();
  }

  /**
   * Cancel the upload. Aborts in-flight requests.
   */
  cancel() {
    this.isCancelled = true;
    this.status = 'cancelled';

    // Abort all in-flight requests
    for (const [, controller] of this.activeRequests) {
      controller.abort();
    }
    this.activeRequests.clear();

    this._emitProgress();
  }

  /**
   * Upload a single chunk with retry logic.
   * @private
   */
  async _uploadChunk(chunkIndex) {
    if (this.isPaused || this.isCancelled) return;

    const start = chunkIndex * this.chunkSize;
    const end = Math.min(start + this.chunkSize, this.file.size);
    let chunkBlob = this.file.slice(start, end);
    let chunkBuffer = await chunkBlob.arrayBuffer();

    // Encrypt if enabled
    let iv = null;
    if (this.encrypt && this.encryptionKey) {
      const encrypted = await encryptChunk(this.encryptionKey, chunkBuffer);
      chunkBuffer = encrypted.ciphertext;
      iv = encrypted.iv;
      this.chunkIVs[chunkIndex] = iv;
      chunkBlob = new Blob([chunkBuffer]);
    }

    // Hash the chunk (after encryption if enabled — we hash what we store)
    const hash = await sha256(chunkBuffer);
    this.chunkHashes[chunkIndex] = hash;

    // Retry loop
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.isPaused || this.isCancelled) return;

      try {
        const controller = new AbortController();
        this.activeRequests.set(chunkIndex, controller);

        const formData = new FormData();
        formData.append('fileId', this.fileId);
        formData.append('chunkIndex', chunkIndex.toString());
        formData.append('chunkHash', hash);
        formData.append('chunk', chunkBlob, `chunk_${chunkIndex}.bin`);

        const { data } = await filesAPI.uploadChunk(formData, controller.signal);

        this.activeRequests.delete(chunkIndex);
        this.uploadedChunks.add(chunkIndex);

        const chunkSize = end - start;
        this.bytesUploaded += chunkSize;

        if (data.data.deduplicated) {
          this.dedupedChunks++;
          this.dedupedBytes += data.data.bytesSaved || chunkSize;
        }

        this._recordSpeed(chunkSize);
        this._emitProgress();
        return; // Success
      } catch (err) {
        this.activeRequests.delete(chunkIndex);

        if (this.isCancelled || err.name === 'CanceledError' || err.name === 'AbortError') return;

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw err; // All retries exhausted
        }
      }
    }
  }

  /** @private */
  _recordSpeed(bytes) {
    const now = Date.now();
    this._speedSamples.push({ time: now, bytes });
    // Keep last 10 seconds of samples
    const cutoff = now - 10000;
    this._speedSamples = this._speedSamples.filter(s => s.time >= cutoff);
  }

  /** @private */
  _getSpeed() {
    if (this._speedSamples.length < 2) return 0;
    const oldest = this._speedSamples[0];
    const newest = this._speedSamples[this._speedSamples.length - 1];
    const elapsed = (newest.time - oldest.time) / 1000;
    if (elapsed <= 0) return 0;
    const totalBytes = this._speedSamples.reduce((sum, s) => sum + s.bytes, 0);
    return totalBytes / elapsed;
  }

  /** @private */
  _emitProgress() {
    const speed = this._getSpeed();
    const remaining = this.file.size - this.bytesUploaded;
    const eta = speed > 0 ? Math.ceil(remaining / speed) : 0;

    /** @type {UploadProgress} */
    const progress = {
      fileId: this.fileId,
      filename: this.file.name,
      totalChunks: this.totalChunks,
      uploadedChunks: this.uploadedChunks.size,
      bytesUploaded: this.bytesUploaded,
      bytesTotal: this.file.size,
      speed,
      eta,
      dedupedChunks: this.dedupedChunks,
      dedupedBytes: this.dedupedBytes,
      status: this.status,
      error: this.error,
      isEncrypted: this.encrypt,
    };

    this.onProgress(progress);
  }
}

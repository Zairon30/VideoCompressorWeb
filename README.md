# Video Compressor (Web)

Browser-based port of the PySide6 desktop app. The compression logic is still
Python (`public/py/compressor_core.py`, run in the browser with Pyodide); ffmpeg.wasm
executes the FFmpeg command Python builds. Nothing is uploaded and no server is needed.

## Run locally
    npm install
    npm run dev

## Deploy to Vercel
1. Push this folder to a Git repo (no Git LFS / ffmpeg.exe needed anymore).
2. Import the repo in Vercel. Framework preset: Vite (auto-detected).
   Build command `npm run build`, output directory `dist`.
3. No environment variables are required.

## Notes
- H.265/HEVC was removed: the standard ffmpeg.wasm build only includes libx264.
- Single-threaded WASM is much slower than the native desktop FFmpeg.
- Very large files (over ~1-2 GB) can exceed browser memory.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const FFMPEG_CORE =
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

const PYODIDE_URL =
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

const MB = 1024 * 1024;
const $ = (id) => document.getElementById(id);

let file = null;
let metaDuration = 0;
let ffmpeg = null;
let core = null;
let cancelled = false;
let outUrl = null;
let pyReady = null;

// ---------- Logging and UI ----------

const log = (message) => {
  const el = $('log');
  el.textContent += `${message}\n`;
  el.scrollTop = el.scrollHeight;
};

const setStatus = (message) => {
  $('status').textContent = message;
};

const setProgress = (percent) => {
  $('bar').value = Math.max(0, Math.min(100, percent));
};

const busy = (isBusy) => {
  $('go').disabled = isBusy || !file;
  $('cancel').disabled = !isBusy;
};

// ---------- Python / Pyodide ----------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');

    script.src = src;
    script.onload = resolve;
    script.onerror = () => {
      reject(new Error(`Failed to load ${src}`));
    };

    document.head.appendChild(script);
  });
}

function loadPython() {
  if (pyReady) return pyReady;

  pyReady = (async () => {
    setStatus('Starting Python...');

    if (!globalThis.loadPyodide) {
      await loadScript(`${PYODIDE_URL}pyodide.js`);
    }

    const py = await globalThis.loadPyodide({
      indexURL: PYODIDE_URL,
    });

    const response = await fetch('/py/compressor_core.py');

    if (!response.ok) {
      throw new Error(
        'Cannot load /py/compressor_core.py. ' +
        'Check that the file is inside the public/py folder.'
      );
    }

    const source = await response.text();

    py.FS.writeFile(
      '/home/pyodide/compressor_core.py',
      source
    );

    py.runPython(`
import sys
sys.path.insert(0, '/home/pyodide')
`);

    core = py.pyimport('compressor_core');

    setStatus(file ? 'Video loaded successfully.' : 'Ready');

    return core;
  })().catch((error) => {
    pyReady = null;
    throw error;
  });

  return pyReady;
}

// ---------- Compression profile ----------

function updateHint() {
  const isTikTok = $('profile').value === 'tiktok';

  $('standard-settings').hidden = isTikTok;
  $('tiktok-settings').hidden = !isTikTok;

  $('profile-hint').textContent = isTikTok
    ? 'TikTok mode: manually configure resolution, aspect ratio, FPS, CRF, encoder preset, and audio.'
    : 'Standard mode: configure target size and compression options.';

  if (isTikTok) {
    $('hint').textContent =
      'TikTok uses quality-based CRF encoding. The final file size may vary.';
    return;
  }

  const target = Number($('target').value) || 0;
  const mode = $('mode').value;

  if (mode === 'best') {
    $('hint').textContent =
      `Best Quality: medium preset, targeting approximately ${target} MB.`;
  } else if (mode === 'small') {
    $('hint').textContent =
      `Small File: veryfast preset, targeting approximately ${target} MB.`;
  } else {
    $('hint').textContent =
      `Balanced: fast preset, targeting approximately ${target} MB.`;
  }
}

$('profile').addEventListener('change', updateHint);
$('mode').addEventListener('change', updateHint);
$('target').addEventListener('input', updateHint);

// ---------- Video metadata ----------

function readMeta(videoFile) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(videoFile);

    const done = (result) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };

    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      done({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };

    video.onerror = () => done(null);
    video.src = url;
  });
}

async function loadFile(videoFile) {
  if (!videoFile) return;

  file = videoFile;
  cancelled = false;

  $('log').textContent = '';
  $('result').hidden = true;
  setProgress(0);
  busy(true);

  try {
    const py = await loadPython();
    const metadata = await readMeta(videoFile);

    metaDuration = metadata?.duration || 0;

    $('i-name').textContent = videoFile.name;
    $('i-size').textContent = py.format_bytes(videoFile.size);

    $('i-dur').textContent = metadata
      ? py.format_duration(metaDuration)
      : 'Read during compression';

    $('i-res').textContent = metadata
      ? `${metadata.width} × ${metadata.height}`
      : '--';

    log(py.describe_file(
      videoFile.name,
      videoFile.size,
      metaDuration
    ));

    if (videoFile.size > 1.5 * 1024 ** 3) {
      log(
        'Warning: very large files may exceed browser memory limits.'
      );
    }

    setStatus('Video loaded successfully.');
  } catch (error) {
    setStatus('Failed to load video.');
    log(`ERROR: ${error.message || error}`);
  } finally {
    busy(false);
  }
}

// ---------- File selection and drag-and-drop ----------

const drop = $('drop');

$('file').addEventListener('change', (event) => {
  loadFile(event.target.files[0]);
});

drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('over');
});

drop.addEventListener('dragleave', () => {
  drop.classList.remove('over');
});

drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('over');

  loadFile(event.dataTransfer.files[0]);
});

// ---------- FFmpeg WASM ----------

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;

  setStatus('Loading FFmpeg (first time only)...');

  const instance = new FFmpeg();

  instance.on('log', ({ message }) => {
    log(message);
  });

  instance.on('progress', ({ progress }) => {
    setProgress(progress * 100);
  });

  await instance.load({
    coreURL: await toBlobURL(
      `${FFMPEG_CORE}/ffmpeg-core.js`,
      'text/javascript'
    ),
    wasmURL: await toBlobURL(
      `${FFMPEG_CORE}/ffmpeg-core.wasm`,
      'application/wasm'
    ),
  });

  ffmpeg = instance;

  return instance;
}

async function probeDuration(instance, inputName) {
  let output = '';

  const handler = ({ message }) => {
    output += `${message}\n`;
  };

  instance.on('log', handler);

  try {
    // FFmpeg prints the duration while reporting the input information.
    // This command may return a non-zero exit code because no output was
    // specified. We only need its log output here.
    await instance.exec(['-i', inputName]);
  } catch {
    // Expected for an input-only probe.
  } finally {
    instance.off('log', handler);
  }

  return core.parse_duration(output);
}

// ---------- Build settings for Python ----------

function getCompressionParameters(inputName, outputName, duration) {
  const profile = $('profile').value;

  const parameters = {
    profile,
    input_name: inputName,
    output_name: outputName,
    duration,
  };

  if (profile === 'tiktok') {
    Object.assign(parameters, {
      tt_resolution: $('tt-resolution').value,
      tt_aspect: $('tt-aspect').value,
      tt_fps: Number($('tt-fps').value),
      tt_crf: Number($('tt-crf').value),
      tt_preset: $('tt-preset').value,
      tt_audio: Number($('tt-audio').value),
    });
  } else {
    Object.assign(parameters, {
      resolution: $('res').value,
      fps: Number($('fps').value),
      codec: 'libx264',
      audio_bitrate: Number($('audio').value),
      compression_mode: $('mode').value,
      target_size_mb: Number($('target').value),
    });
  }

  return parameters;
}

// ---------- Compress video ----------

async function compress() {
  if (!file) return;

  const profile = $('profile').value;
  const targetMB = Number($('target').value);

  // Validate target size only for Standard Compression.
  if (profile === 'standard') {
    if (!Number.isFinite(targetMB) || targetMB < 1 || targetMB > 5000) {
      setStatus('Invalid target size.');
      log('ERROR: Target size must be between 1 and 5000 MB.');
      return;
    }

    if (
      targetMB * MB >= file.size &&
      !confirm(
        `Original: ${(file.size / MB).toFixed(2)} MB\n` +
        `Target: ${targetMB} MB\n\n` +
        'The target is not smaller than the original. Continue anyway?'
      )
    ) {
      return;
    }
  }

  cancelled = false;
  busy(true);

  $('result').hidden = true;
  $('log').textContent = '';
  setProgress(0);

  const extension = (
    file.name.split('.').pop() || 'mp4'
  ).toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';

  const inputName = `input.${extension}`;
  const outputName = 'output.mp4';

  let instance = null;
  let inputWritten = false;

  try {
    const py = await loadPython();

    if (cancelled) return;

    instance = await getFFmpeg();

    if (cancelled) return;

    setStatus('Reading video...');

    await instance.writeFile(
      inputName,
      await fetchFile(file)
    );

    inputWritten = true;

    const probedDuration = await probeDuration(
      instance,
      inputName
    );

    const duration = probedDuration || metaDuration;

    if (cancelled) return;

    const parameters = getCompressionParameters(
      inputName,
      outputName,
      duration
    );

    const plan = JSON.parse(
      py.build_plan(JSON.stringify(parameters))
    );

    plan.log.forEach(log);

    log(
      'Starting FFmpeg...\n' +
      'ffmpeg ' + plan.args.join(' ') + '\n'
    );

    setStatus(
      profile === 'tiktok'
        ? 'Encoding TikTok video...'
        : 'Compressing video...'
    );

    const exitCode = await instance.exec(plan.args);

    if (cancelled) return;

    if (exitCode !== 0) {
      throw new Error(
        `FFmpeg failed with exit code ${exitCode}. Check the log.`
      );
    }

    const data = await instance.readFile(outputName);

    if (cancelled) return;

    const blob = new Blob([data], {
      type: 'video/mp4',
    });

    await instance.deleteFile(inputName).catch(() => {});
    inputWritten = false;

    await instance.deleteFile(outputName).catch(() => {});

    if (outUrl) {
      URL.revokeObjectURL(outUrl);
    }

    outUrl = URL.createObjectURL(blob);

    const outputFileName = py.output_name(file.name);

    $('preview').src = outUrl;
    $('download').href = outUrl;
    $('download').download = outputFileName;
    $('result').hidden = false;

    // Target-size comparison only applies to Standard Compression.
    log(
      py.summarize(
        blob.size,
        file.size,
        profile === 'standard' ? targetMB : 0
      )
    );

    setProgress(100);
    setStatus(`Compression complete: ${outputFileName}`);
  } catch (error) {
    if (cancelled) {
      setStatus('Compression cancelled.');
      log('Compression cancelled.');
    } else {
      setStatus('Compression failed.');
      log(`ERROR: ${error.message || error}`);
    }
  } finally {
    if (instance && inputWritten) {
      await instance.deleteFile(inputName).catch(() => {});
    }

    busy(false);
  }
}

$('go').addEventListener('click', compress);

$('cancel').addEventListener('click', () => {
  cancelled = true;
  setStatus('Cancelling...');

  if (ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null;
  }
});

// ---------- Initial state ----------

updateHint();

loadPython().catch((error) => {
  setStatus('Failed to start Python.');
  log(`ERROR: ${error.message || error}`);
});
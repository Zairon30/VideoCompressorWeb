import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

const FFMPEG_CORE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/'
const MB = 1024 * 1024
const $ = (id) => document.getElementById(id)

let file = null
let metaDuration = 0
let ffmpeg = null
let core = null // the Python module (public/py/compressor_core.py)
let cancelled = false
let outUrl = null

const log = (msg) => { const el = $('log'); el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight }
const setStatus = (t) => { $('status').textContent = t }
const setProgress = (p) => { $('bar').value = Math.max(0, Math.min(100, p)) }
const busy = (b) => { $('go').disabled = b || !file; $('cancel').disabled = !b }

// ---------- Python (Pyodide) ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Failed to load ' + src))
    document.head.appendChild(s)
  })
}

let pyReady = null
function loadPython() {
  if (pyReady) return pyReady
  pyReady = (async () => {
    setStatus('Starting Python...')
    await loadScript(PYODIDE_URL + 'pyodide.js')
    const py = await globalThis.loadPyodide({ indexURL: PYODIDE_URL })
    const src = await (await fetch('/py/compressor_core.py')).text()
    py.FS.writeFile('/home/pyodide/compressor_core.py', src)
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide')")
    core = py.pyimport('compressor_core')
    setStatus(file ? 'Video loaded successfully.' : 'Ready')
    return core
  })()
  return pyReady
}

// ---------- UI helpers ----------
function updateHint() {
  const t = Number($('target').value) || 0
  const m = $('mode').value
  $('hint').textContent =
    m === 'best' ? `Best Quality: slower preset, better efficiency at about ${t} MB.`
    : m === 'small' ? `Small File: faster encoding, targets about ${t} MB.`
    : `Balanced: targets about ${t} MB while keeping good quality.`
}

function readMeta(f) {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    const url = URL.createObjectURL(f)
    const done = (r) => { URL.revokeObjectURL(url); resolve(r) }
    v.preload = 'metadata'
    v.onloadedmetadata = () => done({ duration: v.duration, w: v.videoWidth, h: v.videoHeight })
    v.onerror = () => done(null) // MKV/AVI etc: FFmpeg reads it later
    v.src = url
  })
}

async function loadFile(f) {
  if (!f) return
  file = f
  $('log').textContent = ''
  $('result').hidden = true
  setProgress(0)
  const py = await loadPython()
  const meta = await readMeta(f)
  metaDuration = meta?.duration || 0
  $('i-name').textContent = f.name
  $('i-size').textContent = py.format_bytes(f.size)
  $('i-dur').textContent = meta ? py.format_duration(metaDuration) : 'Read during compression'
  $('i-res').textContent = meta?.w ? `${meta.w} × ${meta.h}` : '--'
  log(py.describe_file(f.name, f.size, metaDuration))
  if (f.size > 1.5 * 1024 ** 3) log('Warning: very large files may exceed browser memory limits.')
  setStatus('Video loaded successfully.')
  busy(false)
}

const drop = $('drop')
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]))
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over')
  loadFile(e.dataTransfer.files[0])
})

// ---------- FFmpeg (WASM executor) ----------
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg
  setStatus('Loading FFmpeg (first time only)...')
  const f = new FFmpeg()
  f.on('log', ({ message }) => log(message))
  f.on('progress', ({ progress }) => setProgress(progress * 100))
  await f.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.wasm`, 'application/wasm'),
  })
  ffmpeg = f
  return f
}

// No ffprobe in the browser: run `ffmpeg -i` and let Python parse the Duration line.
async function probeDuration(f, name) {
  let text = ''
  const h = ({ message }) => { text += message + '\n' }
  f.on('log', h)
  await f.exec(['-i', name])
  f.off('log', h)
  return core.parse_duration(text)
}

async function compress() {
  if (!file) return
  const py = await loadPython()
  const targetMB = Number($('target').value)

  if (targetMB * MB >= file.size &&
      !confirm(`Original: ${(file.size / MB).toFixed(2)} MB\nTarget: ${targetMB} MB\n\nThe target is not smaller than the original. Continue anyway?`)) return

  cancelled = false
  busy(true)
  $('result').hidden = true
  $('log').textContent = ''
  setProgress(0)

  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4'
  const input = `input.${ext}`
  const output = 'output.mp4'

  try {
    const f = await getFFmpeg()
    setStatus('Reading video...')
    await f.writeFile(input, await fetchFile(file))

    const duration = (await probeDuration(f, input)) || metaDuration

    // Python decides bitrate, preset, filters and the full FFmpeg argument list.
    const plan = JSON.parse(py.build_plan(JSON.stringify({
      input_name: input,
      output_name: output,
      duration,
      resolution: $('res').value,
      fps: Number($('fps').value),
      codec: 'libx264',
      audio_bitrate: Number($('audio').value),
      compression_mode: $('mode').value,
      target_size_mb: targetMB,
    })))
    plan.log.forEach(log)
    log('Starting FFmpeg...\nffmpeg ' + plan.args.join(' ') + '\n')

    setStatus('Compressing...')
    const code = await f.exec(plan.args)
    if (code !== 0) throw new Error(`FFmpeg failed with exit code ${code}. Check the FFmpeg log.`)

    const data = await f.readFile(output)
    const blob = new Blob([data.buffer], { type: 'video/mp4' })
    await f.deleteFile(input).catch(() => {})
    await f.deleteFile(output).catch(() => {})

    if (outUrl) URL.revokeObjectURL(outUrl)
    outUrl = URL.createObjectURL(blob)
    const outName = py.output_name(file.name)
    $('preview').src = outUrl
    $('download').href = outUrl
    $('download').download = outName
    $('result').hidden = false

    log(py.summarize(blob.size, file.size, targetMB))
    setProgress(100)
    setStatus(`Compression complete: ${outName}`)
  } catch (err) {
    if (cancelled) { setStatus('Compression cancelled.'); log('Compression cancelled.') }
    else { setStatus('Compression failed.'); log(`ERROR: ${err.message || err}`) }
  } finally {
    busy(false)
  }
}

$('go').addEventListener('click', compress)
$('cancel').addEventListener('click', () => {
  cancelled = true
  setStatus('Cancelling...')
  ffmpeg?.terminate()
  ffmpeg = null
})
$('mode').addEventListener('change', updateHint)
$('target').addEventListener('input', updateHint)
updateHint()
loadPython().catch((e) => { setStatus('Failed to start Python.'); log('ERROR: ' + e.message) })

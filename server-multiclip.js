const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(cors());

const upload = multer({ dest: os.tmpdir() });

function runFfmpeg(args){
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if(err){ err.stderr = stderr; return reject(err); }
      resolve();
    });
  });
}

app.get('/', (req, res) => {
  res.send('Reel Builder render server is running.');
});

app.post('/merge', upload.fields([{ name: 'videos', maxCount: 20 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  const jobId = crypto.randomUUID();
  const speed = parseFloat(req.body.speed || '2') || 2;

  if (!req.files || !req.files.videos || !req.files.videos.length || !req.files.audio) {
    return res.status(400).json({ error: 'At least one video and one audio file are required.' });
  }

  // Shuffle the clips so repeat builds don't always play in upload order.
  const videoPaths = req.files.videos.map(f => f.path);
  for (let i = videoPaths.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [videoPaths[i], videoPaths[j]] = [videoPaths[j], videoPaths[i]];
  }

  const audioPath = req.files.audio[0].path;
  const combinedPath = path.join(os.tmpdir(), jobId + '-combined.mp4');
  const outputPath = path.join(os.tmpdir(), jobId + '-output.mp4');

  const cleanup = () => {
    videoPaths.forEach(p => fs.unlink(p, () => {}));
    fs.unlink(audioPath, () => {});
    fs.unlink(combinedPath, () => {});
  };

  try {
    // Step 1: speed up and stitch every uploaded clip together, in
    // shuffled order, into one combined (audio-less) video. Using all
    // the clips instead of just one, back to back.
    const filterParts = videoPaths.map((_, i) =>
      `[${i}:v]setpts=PTS/${speed},fps=30,scale=720:-2[v${i}]`
    );
    const concatInputs = videoPaths.map((_, i) => `[v${i}]`).join('');
    filterParts.push(`${concatInputs}concat=n=${videoPaths.length}:v=1:a=0[vout]`);
    const filterComplex = filterParts.join(';');

    const inputArgs = videoPaths.flatMap(p => ['-i', p]);
    await runFfmpeg([
      '-y', ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      combinedPath
    ]);

    // Step 2: loop that combined sequence to fill the voiceover exactly
    // (loops automatically if shorter, cuts off automatically if longer).
    await runFfmpeg([
      '-y',
      '-stream_loop', '-1', '-i', combinedPath,
      '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-movflags', '+faststart',
      outputPath
    ]);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="vynxstories content.mp4"');
    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('close', () => { fs.unlink(outputPath, () => {}); cleanup(); });
  } catch (err) {
    console.error('ffmpeg failed:', err.stderr || err.message);
    cleanup();
    res.status(500).json({ error: 'ffmpeg failed', detail: (err.stderr || err.message || '').slice(-2000) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Listening on port ' + PORT));

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

  const videoPaths = req.files.videos.map(f => f.path);
  for (let i = videoPaths.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [videoPaths[i], videoPaths[j]] = [videoPaths[j], videoPaths[i]];
  }

  const audioPath = req.files.audio[0].path;
  const segmentPaths = videoPaths.map((_, i) => path.join(os.tmpdir(), jobId + '-seg' + i + '.mp4'));
  const listPath = path.join(os.tmpdir(), jobId + '-list.txt');
  const combinedPath = path.join(os.tmpdir(), jobId + '-combined.mp4');
  const outputPath = path.join(os.tmpdir(), jobId + '-output.mp4');

  const cleanup = () => {
    videoPaths.forEach(p => fs.unlink(p, () => {}));
    segmentPaths.forEach(p => fs.unlink(p, () => {}));
    fs.unlink(audioPath, () => {});
    fs.unlink(listPath, () => {});
    fs.unlink(combinedPath, () => {});
  };

  try {
    // Step 1: speed up each uploaded clip individually into a matching
    // format, one simple ffmpeg call per clip (easier to debug than one
    // giant combined command, and each clip fails independently rather
    // than breaking the whole job).
    for (let i = 0; i < videoPaths.length; i++) {
      await runFfmpeg([
        '-y', '-i', videoPaths[i],
        '-filter:v', 'setpts=PTS/' + speed + ',fps=30,scale=720:-2',
        '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        segmentPaths[i]
      ]);
    }

    // Step 2: stitch the already-matching segments together with the
    // concat demuxer (a plain text list, not a complex filter string -
    // much less to go wrong).
    const listContent = segmentPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent);
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', combinedPath
    ]);

    // Step 3: loop the combined sequence to fill the voiceover exactly
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

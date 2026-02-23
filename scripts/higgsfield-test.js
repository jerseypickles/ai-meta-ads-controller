/**
 * Higgsfield API Test Script (Official Node.js SDK)
 *
 * Usage:
 *   node scripts/higgsfield-test.js list-motions
 *   node scripts/higgsfield-test.js list-styles
 *   node scripts/higgsfield-test.js generate <image_url> [prompt]
 *   node scripts/higgsfield-test.js status <job_set_id>
 *   node scripts/higgsfield-test.js test-connection
 */

const CREDENTIALS = 'd03d2949-0d83-491b-bf77-e845a8e17fb8:d982ba18914e52b339d1adbc78d68849be1e4b4449f0bb2473b6c10dadf3a028';

// ═══════════════════════════════════════════════
// Also test with raw fetch for endpoints not in SDK
// ═══════════════════════════════════════════════
const API_BASE = 'https://platform.higgsfield.ai';
const [API_KEY, API_SECRET] = CREDENTIALS.split(':');

const rawHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'hf-api-key': API_KEY,
  'hf-secret': API_SECRET
};

async function rawRequest(method, path) {
  const url = `${API_BASE}${path}`;
  console.log(`→ ${method} ${url}`);
  try {
    const res = await fetch(url, { method, headers: rawHeaders });
    const text = await res.text();
    if (!res.ok) {
      console.error(`✗ ${res.status}: ${text.substring(0, 300)}`);
      return null;
    }
    return JSON.parse(text);
  } catch (err) {
    console.error(`✗ Error: ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════
// TEST CONNECTION — verify auth works
// ═══════════════════════════════════════════════
async function testConnection() {
  console.log('═══ Testing Connection ═══\n');

  // Try SDK v2
  try {
    const { config, higgsfield } = require('@higgsfield/client/v2');
    config({ credentials: CREDENTIALS });
    console.log('✓ SDK v2 loaded and configured\n');

    // Try a simple text-to-image to verify auth
    // Test text-to-image (cheapest operation)
    console.log('Testing auth with text-to-image (Soul)...');
    try {
      const jobSet = await higgsfield.subscribe('/v1/text2image/soul', {
        input: {
          prompt: 'A jar of pickles on a white background, product photo, studio lighting',
          quality: '720p'
        },
        withPolling: true
      });

      console.log(`✓ Job completed! ID: ${jobSet.id}`);
      console.log(`  Status: completed=${jobSet.isCompleted} failed=${jobSet.isFailed}`);
      for (const job of jobSet.jobs) {
        if (job.results) {
          console.log(`  Image: ${job.results.raw?.url || job.results.min?.url || JSON.stringify(job.results)}`);
        }
      }
    } catch (err) {
      console.error(`✗ Soul error: ${err.message}`);
      // Try to see actual response
      if (err.response) {
        console.error(`  Status: ${err.response.status}`);
        try { console.error(`  Body: ${JSON.stringify(err.response.data).substring(0, 500)}`); } catch {}
      }

      // Try flux as alternative
      console.log('\nTrying flux-pro/kontext...');
      try {
        const jobSet2 = await higgsfield.subscribe('flux-pro/kontext/max/text-to-image', {
          input: {
            prompt: 'A jar of pickles, product photo',
            aspect_ratio: '9:16'
          },
          withPolling: true
        });
        console.log(`✓ Flux job completed! ID: ${jobSet2.id}`);
        for (const job of jobSet2.jobs) {
          if (job.results) {
            console.log(`  Image: ${job.results.raw?.url || JSON.stringify(job.results)}`);
          }
        }
      } catch (err2) {
        console.error(`✗ Flux error: ${err2.message}`);
        if (err2.response) {
          try { console.error(`  Body: ${JSON.stringify(err2.response.data).substring(0, 500)}`); } catch {}
        }
      }
    }
  } catch (err) {
    console.error(`✗ SDK load error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════
// LIST MOTIONS
// ═══════════════════════════════════════════════
async function listMotions() {
  console.log('═══ Available Motion Presets ═══\n');

  // Try raw API
  const data = await rawRequest('GET', '/v1/motions');
  if (!data) {
    // Try with SDK
    try {
      const { createHiggsfieldClient } = require('@higgsfield/client/v2');
      const client = createHiggsfieldClient({ credentials: CREDENTIALS });
      // SDK might not have a list-motions method, try raw
      console.log('Raw API failed. Motion presets might need to be fetched via the web dashboard.');
    } catch (e) {
      console.error('SDK also failed:', e.message);
    }
    return;
  }

  if (Array.isArray(data)) {
    console.log(`Found ${data.length} motion presets:\n`);
    for (const m of data) {
      const name = m.name || m.label || m.title || 'unnamed';
      const id = m.id || m.motion_id || 'no-id';
      console.log(`  ${name.padEnd(35)} ${id}`);
    }
  } else if (data.motions) {
    console.log(`Found ${data.motions.length} motion presets:\n`);
    for (const m of data.motions) {
      const name = m.name || m.label || 'unnamed';
      const id = m.id || 'no-id';
      console.log(`  ${name.padEnd(35)} ${id}`);
    }
  } else {
    console.log(JSON.stringify(data, null, 2).substring(0, 3000));
  }
}

// ═══════════════════════════════════════════════
// LIST STYLES
// ═══════════════════════════════════════════════
async function listStyles() {
  console.log('═══ Available Styles ═══\n');
  const data = await rawRequest('GET', '/v1/text2image/soul-styles');
  if (!data) return;
  console.log(JSON.stringify(data, null, 2).substring(0, 3000));
}

// ═══════════════════════════════════════════════
// GENERATE VIDEO — image-to-video via SDK
// ═══════════════════════════════════════════════
async function generateVideo(imageUrl, prompt) {
  console.log('═══ Generating Video (Image-to-Video) ═══\n');
  console.log(`Image:  ${imageUrl}`);
  console.log(`Prompt: ${prompt || 'Smooth dolly in on product, studio lighting, professional product video'}`);

  const { config, higgsfield } = require('@higgsfield/client/v2');
  config({ credentials: CREDENTIALS });

  const finalPrompt = prompt || 'Smooth dolly in on product, studio lighting, professional product video, slow elegant camera movement';

  try {
    console.log('\nSubmitting to image2video/dop...');
    const jobSet = await higgsfield.subscribe('/v1/image2video/dop', {
      input: {
        model: 'dop-turbo',
        prompt: finalPrompt,
        input_images: [{
          type: 'image_url',
          image_url: imageUrl
        }]
      },
      withPolling: true
    });

    console.log(`\n✓ Job completed! ID: ${jobSet.id}`);
    console.log(`  Status: completed=${jobSet.isCompleted} failed=${jobSet.isFailed} nsfw=${jobSet.isNsfw}`);

    for (const job of jobSet.jobs) {
      if (job.results) {
        const url = job.results.raw?.url || job.results.min?.url;
        console.log(`  Video URL: ${url}`);
      }
    }
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
    if (err.response) {
      console.error(`  Status: ${err.response.status}`);
      console.error(`  Body: ${JSON.stringify(err.response.data || '').substring(0, 500)}`);
    }
  }
}

// ═══════════════════════════════════════════════
// CHECK STATUS
// ═══════════════════════════════════════════════
async function checkStatus(jobSetId) {
  console.log(`═══ Job Status: ${jobSetId} ═══\n`);
  const data = await rawRequest('GET', `/v1/job-sets/${jobSetId}`);
  if (!data) return;
  console.log(JSON.stringify(data, null, 2));
}

// ═══════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════
async function main() {
  const [,, command, ...args] = process.argv;

  if (!command) {
    console.log('Higgsfield API Test Script\n');
    console.log('Usage:');
    console.log('  node scripts/higgsfield-test.js test-connection');
    console.log('  node scripts/higgsfield-test.js list-motions');
    console.log('  node scripts/higgsfield-test.js list-styles');
    console.log('  node scripts/higgsfield-test.js generate <image_url> [prompt]');
    console.log('  node scripts/higgsfield-test.js status <job_set_id>');
    return;
  }

  switch (command) {
    case 'test-connection':
      await testConnection();
      break;
    case 'list-motions':
      await listMotions();
      break;
    case 'list-styles':
      await listStyles();
      break;
    case 'generate':
      if (!args[0]) { console.error('Need: <image_url> [prompt]'); return; }
      await generateVideo(args[0], args.slice(1).join(' ') || null);
      break;
    case 'status':
      if (!args[0]) { console.error('Need: <job_set_id>'); return; }
      await checkStatus(args[0]);
      break;
    default:
      console.error(`Unknown command: ${command}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

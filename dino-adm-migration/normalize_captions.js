// One-off: normalizes manhole image captions to "Boca de visita N" (by
// creation-order position) for images that were attached before this
// captioning convention existed. Only updates the caption text via
// PATCH /assets/references/:id - does not touch the image file or any
// other data.

const axios = require('axios');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const UNITY_ID = process.env.UNITY_ID || '40bad137-7ac4-4522-a38b-cf7edeeb2b36';
const TOKEN = fs.readFileSync(__dirname + '/auth/unity_token.txt', 'utf-8');
const client = axios.create({ baseURL: BASE_URL, headers: { Authorization: `Bearer ${TOKEN}` }, validateStatus: () => true });

function unwrap(res, label) {
  if (res.status >= 400) throw new Error(`${label} failed [${res.status}]: ${JSON.stringify(res.data)}`);
  return res.data.data;
}

async function main() {
  const list = unwrap(await client.get('/confined-spaces', { params: { unityId: UNITY_ID } }), 'list confined spaces');
  let updated = 0, alreadyOk = 0, failed = 0;

  for (const cs of list) {
    try {
      const general = unwrap(await client.get(`/confined-spaces/${cs.id}/forms/general`), `get general ${cs.tag}`);
      const data = general.data;
      if (!data) continue;

      const manholes = [...(data.manholes || [])].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      for (let i = 0; i < manholes.length; i++) {
        const manhole = manholes[i];
        const expectedCaption = `Boca de visita ${i + 1}`;
        for (const img of manhole.images || []) {
          if (img.caption === expectedCaption) {
            alreadyOk++;
            continue;
          }
          unwrap(
            await client.patch(`/assets/references/${img.id}`, { caption: expectedCaption }),
            `update caption ${cs.tag} manhole ${i + 1}`,
          );
          console.log(`Updated caption: ${cs.tag} -> "${expectedCaption}" (was "${img.caption}")`);
          updated++;
        }
      }
    } catch (err) {
      failed++;
      console.error(`FAILED: ${cs.tag} - ${err.message}`);
    }
  }

  console.log('\n--- Summary ---');
  console.log('Already correct:', alreadyOk);
  console.log('Updated:', updated);
  console.log('Failed:', failed);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

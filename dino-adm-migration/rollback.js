// Reverts exactly what a single reconcile.js LIVE run did, using the
// migration_journal_*.json file that run wrote out. Processes actions in
// REVERSE order (last thing done is undone first), each one isolated in its
// own try/catch so one failure never stops the rest.
//
// What gets reverted, and how:
//   - attach_image      -> DELETE /assets/references/:id (removes just that
//                          photo attachment; if it was already removed/
//                          replaced since, this is skipped, not fatal).
//   - add_manholes      -> re-fetches the space's current manholes, keeps
//                          any manhole whose id is NOT in this journal entry
//                          untouched, and sends a general draft with only
//                          the surviving manholes - this only removes the
//                          exact manholes this run created, even if a human
//                          added more manholes since.
//   - fill_general /
//     fill_ventilation  -> re-opens the section draft and sets exactly the
//                          fields this run filled back to null (nothing
//                          else is touched).
//   - link_rescue       -> unlinks the rescue method, but ONLY if the space
//                          is still linked to exactly the method this run
//                          linked (if a human changed it since, this is
//                          skipped and reported, never overwritten).
//   - create_confined_space -> deactivates the space (isActive: false).
//                          There is no hard-delete endpoint for confined
//                          spaces in this app, and deactivating is the same
//                          reversible action available from the UI - it
//                          keeps the audit trail intact instead of erasing
//                          history.
//   - create_installation / create_area -> NOT deleted automatically. Other
//                          confined spaces created in the very same run (or
//                          pre-existing ones) may reference the same
//                          installation/area, so deleting it here risks
//                          breaking unrelated records. These are only
//                          listed in the rollback report for manual review/
//                          deletion via the UI if truly empty afterwards.
//
// Usage:
//   node rollback.js path/to/migration_journal_....json

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.MIGRATION_EMAIL;
const PASSWORD = process.env.MIGRATION_PASSWORD;
let UNITY_ID = process.env.UNITY_ID;
const CLIENT_NAME = process.env.CLIENT_NAME;
const UNITY_NAME = process.env.UNITY_NAME;

const journalPath = process.argv[2];
if (!journalPath) {
  console.error('Usage: node rollback.js path/to/migration_journal_....json');
  process.exit(1);
}
if (!fs.existsSync(journalPath)) {
  console.error(`Journal file not found: ${journalPath}`);
  process.exit(1);
}
if (!UNITY_ID && !(CLIENT_NAME && UNITY_NAME)) {
  console.error('Set UNITY_ID, or CLIENT_NAME + UNITY_NAME, env vars to identify the target unity.');
  process.exit(1);
}

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const REPORT_FILE = journalPath.replace(/\.json$/, '') + '_rollback_report.json';

let client;

function normalizeCompare(v) {
  return (v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

async function login() {
  console.log(`Logging in as ${EMAIL} ...`);
  const loginRes = await axios.post(`${BASE_URL}/auth/login`, { email: EMAIL, password: PASSWORD });
  const initialToken = loginRes.data.data.accessToken;

  if (!UNITY_ID) {
    const clients = loginRes.data.data.user.clients || [];
    const matchedClient = clients.find((c) => normalizeCompare(c.name) === normalizeCompare(CLIENT_NAME));
    if (!matchedClient) {
      console.error(`Client "${CLIENT_NAME}" not found for this user. Available: ${clients.map((c) => c.name).join(', ')}`);
      process.exit(1);
    }
    const matchedUnity = matchedClient.unities.find((u) => normalizeCompare(u.name) === normalizeCompare(UNITY_NAME));
    if (!matchedUnity) {
      console.error(`Unity "${UNITY_NAME}" not found under client "${matchedClient.name}". Available: ${matchedClient.unities.map((u) => u.name).join(', ')}`);
      process.exit(1);
    }
    UNITY_ID = matchedUnity.id;
    console.log(`Resolved client "${matchedClient.name}" -> unity "${matchedUnity.name}" (${UNITY_ID})`);
  }

  const selRes = await axios.post(
    `${BASE_URL}/auth/select-unity`,
    { unityId: UNITY_ID },
    { headers: { Authorization: `Bearer ${initialToken}` } },
  );
  client = axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${selRes.data.data.accessToken}` },
    validateStatus: () => true,
  });
  console.log('Logged in.');
}

function unwrap(res, label) {
  if (res.status >= 400) {
    const msg = res.data && res.data.error ? JSON.stringify(res.data.error) : JSON.stringify(res.data);
    throw new Error(`${label} failed [${res.status}]: ${msg}`);
  }
  return res.data.data;
}

async function beginGeneralEdit(confinedSpaceId, formId) {
  const editRes = unwrap(
    await client.post(`/confined-spaces/${confinedSpaceId}/forms/general/edit`, formId ? { formId } : {}),
    `begin general edit ${confinedSpaceId}`,
  );
  return editRes.data.lockSessionId;
}

async function saveAndPublishGeneral(confinedSpaceId, lockSessionId, payload) {
  unwrap(
    await client.put(`/confined-spaces/${confinedSpaceId}/forms/general/draft`, { lockSessionId, ...payload }),
    `save general draft ${confinedSpaceId}`,
  );
  unwrap(
    await client.post(`/confined-spaces/${confinedSpaceId}/forms/general/publish`, {}),
    `publish general ${confinedSpaceId}`,
  );
}

async function revertAttachImage(entry, report) {
  const res = await client.delete(`/assets/references/${entry.referenceId}`);
  if (res.status === 404) {
    report.skipped.push({ ...entry, reason: 'reference already removed' });
    return;
  }
  if (res.status >= 400) throw new Error(`delete reference failed [${res.status}]`);
  report.reverted.push(entry);
  console.log(`  revertido: foto "${entry.caption}" (${entry.tag})`);
}

async function revertAddManholes(entry, report) {
  const fresh = unwrap(
    await client.get(`/confined-spaces/${entry.confinedSpaceId}/forms/general`),
    `get general ${entry.tag}`,
  );
  const data = (fresh && fresh.data) || {};
  const currentManholes = data.manholes || [];
  const addedIds = new Set(entry.manholeIds);
  const survivors = currentManholes.filter((m) => !addedIds.has(m.id));

  if (survivors.length === currentManholes.length) {
    report.skipped.push({ ...entry, reason: 'manholes already removed' });
    return;
  }

  const lockSessionId = await beginGeneralEdit(entry.confinedSpaceId, data.id);
  const manholesPayload = survivors.map((m) => ({
    id: m.id,
    manholeCode: m.manholeCode,
    manholeDimension: m.manholeDimension,
    access: m.access,
    hasLadder: m.hasLadder,
    hasInternalInterference: m.hasInternalInterference,
    observationsComments: m.observationsComments,
    referenceDocument: m.referenceDocument,
  }));
  await saveAndPublishGeneral(entry.confinedSpaceId, lockSessionId, { manholes: manholesPayload });
  report.reverted.push(entry);
  console.log(`  revertido: ${addedIds.size} boca(s) de visita removida(s) (${entry.tag})`);
}

async function revertFillGeneral(entry, report) {
  const fresh = unwrap(
    await client.get(`/confined-spaces/${entry.confinedSpaceId}/forms/general`),
    `get general ${entry.tag}`,
  );
  const nulledFields = {};
  for (const key of Object.keys(entry.fields)) nulledFields[key] = null;

  const lockSessionId = await beginGeneralEdit(entry.confinedSpaceId, fresh.data.id);
  await saveAndPublishGeneral(entry.confinedSpaceId, lockSessionId, nulledFields);
  report.reverted.push(entry);
  console.log(`  revertido: campos gerais ${Object.keys(entry.fields).join(', ')} (${entry.tag})`);
}

async function revertFillVentilation(entry, report) {
  const nulledFields = {};
  for (const key of Object.keys(entry.fields)) nulledFields[key] = null;
  unwrap(
    await client.put(`/confined-spaces/${entry.confinedSpaceId}/forms/ventilation/draft`, nulledFields),
    `save ventilation draft ${entry.tag}`,
  );
  unwrap(
    await client.post(`/confined-spaces/${entry.confinedSpaceId}/forms/ventilation/publish`, {}),
    `publish ventilation ${entry.tag}`,
  );
  report.reverted.push(entry);
  console.log(`  revertido: campos de ventilação ${Object.keys(entry.fields).join(', ')} (${entry.tag})`);
}

async function revertLinkRescue(entry, report) {
  const published = unwrap(
    await client.get(`/confined-spaces/${entry.confinedSpaceId}/forms/rescue`),
    `get rescue ${entry.tag}`,
  );
  const currentMethods = (published && published.data && published.data.methods) || [];
  const stillOurs = currentMethods.length === 1 && currentMethods[0].rescueMethodId === entry.rescueMethodId;
  if (!stillOurs) {
    report.skipped.push({ ...entry, reason: 'rescue link changed since this run - not touched' });
    return;
  }
  unwrap(
    await client.put(`/confined-spaces/${entry.confinedSpaceId}/forms/rescue/draft`, { methods: [] }),
    `save rescue draft ${entry.tag}`,
  );
  unwrap(
    await client.post(`/confined-spaces/${entry.confinedSpaceId}/forms/rescue/publish`, {}),
    `publish rescue ${entry.tag}`,
  );
  report.reverted.push(entry);
  console.log(`  revertido: vínculo de resgate "${entry.rescueMethodName}" (${entry.tag})`);
}

async function revertCreateConfinedSpace(entry, report) {
  const fresh = unwrap(
    await client.get(`/confined-spaces/${entry.confinedSpaceId}/forms/general`),
    `get general ${entry.tag}`,
  );
  const lockSessionId = await beginGeneralEdit(entry.confinedSpaceId, fresh.data.id);
  await saveAndPublishGeneral(entry.confinedSpaceId, lockSessionId, { isActive: false });
  report.reverted.push(entry);
  console.log(`  revertido (desativado): espaço confinado "${entry.tag}" - NÃO foi excluído (sem endpoint de exclusão), apenas marcado como inativo`);
}

async function main() {
  await login();
  console.log(`Journal: ${journalPath} (${journal.length} ações)`);
  console.log('Revertendo em ordem inversa...\n');

  const report = { reverted: [], skipped: [], failed: [], notDeleted: [] };

  for (const entry of [...journal].reverse()) {
    try {
      switch (entry.action) {
        case 'attach_image':
          await revertAttachImage(entry, report);
          break;
        case 'add_manholes':
          await revertAddManholes(entry, report);
          break;
        case 'fill_general':
          await revertFillGeneral(entry, report);
          break;
        case 'fill_ventilation':
          await revertFillVentilation(entry, report);
          break;
        case 'link_rescue':
          await revertLinkRescue(entry, report);
          break;
        case 'create_confined_space':
          await revertCreateConfinedSpace(entry, report);
          break;
        case 'create_installation':
        case 'create_area':
          report.notDeleted.push(entry);
          break;
        default:
          report.skipped.push({ ...entry, reason: `unknown action type: ${entry.action}` });
      }
    } catch (err) {
      report.failed.push({ ...entry, error: err.message });
      console.error(`  FALHOU: ${entry.action} (${entry.tag || entry.confinedSpaceId}) - ${err.message}`);
    }
  }

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log('\n--- Resumo do rollback ---');
  console.log('Revertido:', report.reverted.length);
  console.log('Ignorado (já alterado desde então):', report.skipped.length);
  console.log('Falhou:', report.failed.length);
  console.log('Instalações/áreas criadas neste run (NÃO excluídas automaticamente - revisar manualmente):', report.notDeleted.length);
  console.log('Relatório completo:', REPORT_FILE);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

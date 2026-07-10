// Reconciliation migration script.
//
// Unlike migrate.js (which assumes an empty unity and blindly creates
// everything), this script is meant for a unity that may ALREADY have some
// confined spaces registered (production). For every space in the
// spreadsheet it:
//   1. Resolves/creates the Installation and Area.
//   2. Looks for an existing confined space with the same tag+installation.
//      - If it doesn't exist: creates it fully (general + ventilation +
//        rescue), same mapping as migrate.js.
//      - If it exists: fetches the published General/Ventilation forms and
//        ONLY fills fields that are currently empty (null/undefined) with
//        the spreadsheet value. Existing non-null values are never
//        overwritten - if they differ from the spreadsheet, it's reported
//        as a "mismatch" for a human to review, not silently changed.
//   3. Manholes: only added if the confined space doesn't have any yet
//      (avoids creating duplicates on a space that was already detailed
//      manually). If it already has manholes, it's reported, not touched.
//   4. Rescue: methods are expected to already exist in the unity's catalog
//      (looked up by name only - never created here). If the space isn't
//      linked to any rescue method yet, links the matching one. If it's
//      already linked to something, it's left alone and reported.
//
// Run with RECONCILE_REPORT_ONLY=true first to see the plan without writing
// anything.

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.MIGRATION_EMAIL;
const PASSWORD = process.env.MIGRATION_PASSWORD;
// UNITY_ID can be given directly (local testing), or resolved by name via
// CLIENT_NAME + UNITY_NAME (production - looked up from the logged-in
// manager's own client/unity list, so there's no risk of a typo'd UUID
// pointing at the wrong tenant).
let UNITY_ID = process.env.UNITY_ID;
const CLIENT_NAME = process.env.CLIENT_NAME;
const UNITY_NAME = process.env.UNITY_NAME;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'import_data.json');
const REPORT_ONLY = process.env.RECONCILE_REPORT_ONLY === 'true';
const LOG_FILE = path.join(__dirname, REPORT_ONLY ? 'reconcile_report.json' : 'reconcile_run.json');
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const JOURNAL_FILE = path.join(__dirname, `migration_journal_${RUN_TIMESTAMP}.json`);
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, 'extracted_images');
const IMAGE_MANIFEST = (() => {
  const manifestPath = path.join(IMAGES_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const byCadastro = {};
  for (const m of manifest) {
    if (m.kind === 'foto_geral') byCadastro[m.admNumeroCadastro] = m.file;
  }
  return byCadastro;
})();

if (!UNITY_ID && !(CLIENT_NAME && UNITY_NAME)) {
  console.error('Set UNITY_ID, or CLIENT_NAME + UNITY_NAME, env vars to identify the target unity.');
  process.exit(1);
}

const DATA = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));

let client;
const report = {
  created: [],
  filledGaps: [],
  alreadyMatched: [],
  mismatches: [],
  rescueCatalogMissing: [],
  manholesSkipped: [],
  failed: [],
};

// Every mutating action taken against production is appended here (LIVE mode
// only). Written to JOURNAL_FILE at the end of the run and consumed by
// rollback.js to undo exactly what this run did, and nothing else.
const journal = [];
function journalPush(entry) {
  if (REPORT_ONLY) return;
  journal.push({ timestamp: new Date().toISOString(), ...entry });
}

function normalizeCompare(v) {
  return (v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .trim().toLowerCase();
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

async function ensureInstallation(name, cache) {
  const key = name.trim().toLowerCase();
  if (cache.installations[key]) return cache.installations[key];
  const list = unwrap(await client.get('/unity-installations'), 'list installations');
  let found = list.find((i) => i.name.trim().toLowerCase() === key);
  if (!found) {
    if (REPORT_ONLY) {
      cache.installations[key] = `WOULD-CREATE-${key}`;
      return cache.installations[key];
    }
    found = unwrap(await client.post('/unity-installations/create', { name }), `create installation ${name}`);
    console.log(`  -> instalação criada: "${name}" (${found.id})`);
    journalPush({ action: 'create_installation', id: found.id, name });
  }
  cache.installations[key] = found.id;
  return found.id;
}

async function ensureArea(name, installationId, cache) {
  const key = `${installationId}::${name.trim().toLowerCase()}`;
  if (cache.areas[key]) return cache.areas[key];
  const list = installationId.startsWith('WOULD-CREATE-')
    ? []
    : unwrap(await client.get('/unity-areas', { params: { installationId } }), 'list areas');
  let found = list.find((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!found) {
    if (REPORT_ONLY) {
      cache.areas[key] = `WOULD-CREATE-${key}`;
      return cache.areas[key];
    }
    found = unwrap(await client.post('/unity-areas/create', { name, installationId }), `create area ${name}`);
    console.log(`  -> área criada: "${name}" (${found.id})`);
    journalPush({ action: 'create_area', id: found.id, name, installationId });
  }
  cache.areas[key] = found.id;
  return found.id;
}

async function loadCatalog() {
  const [installations, confinedSpaces, rescueMethods] = await Promise.all([
    client.get('/unity-installations'),
    client.get('/confined-spaces', { params: { unityId: UNITY_ID } }),
    client.get('/rescue-methods', { params: { unityId: UNITY_ID } }),
  ]);
  return {
    confinedSpaces: unwrap(confinedSpaces, 'list confined spaces'),
    rescueMethods: unwrap(rescueMethods, 'list rescue methods'),
  };
}

// Only keeps keys whose current DB value is null/undefined AND whose
// spreadsheet value is non-null - i.e. genuine gaps, never overwrites.
function buildFillPayload(current, source) {
  const fill = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === null || v === undefined) continue;
    if (k === 'customFieldsJson') {
      const existingCustom = current.customFieldsJson || {};
      const missingCustom = {};
      for (const [ck, cv] of Object.entries(v)) {
        if (existingCustom[ck] === undefined || existingCustom[ck] === null) {
          missingCustom[ck] = cv;
        }
      }
      if (Object.keys(missingCustom).length) {
        fill.customFieldsJson = { ...existingCustom, ...missingCustom };
      }
      continue;
    }
    const currentVal = current[k];
    if (currentVal === null || currentVal === undefined || currentVal === '') {
      fill[k] = v;
    }
  }
  return fill;
}

function findMismatches(current, source) {
  const mismatches = [];
  for (const [k, v] of Object.entries(source)) {
    if (v === null || v === undefined || k === 'customFieldsJson') continue;
    const currentVal = current[k];
    if (currentVal !== null && currentVal !== undefined && currentVal !== '' && String(currentVal) !== String(v)) {
      mismatches.push({ field: k, current: currentVal, spreadsheet: v });
    }
  }
  return mismatches;
}

// Tracks the confined space id the current record is operating on, so that
// if reconcileConfinedSpace throws partway through, main()'s catch block
// knows which space to run discardStaleDraftsIfAny() against - without this
// a failed general/ventilation/rescue edit call leaves its draft dangling
// forever (never published, never discarded, never picked up again by this
// script since it always derives a fresh draft from the last published
// form rather than resuming an existing one - see README).
let lastConfinedSpaceId = null;

async function reconcileConfinedSpace(rec, cache, catalog) {
  lastConfinedSpaceId = null;
  const installationId = await ensureInstallation(rec.installation, cache);
  const areaId = await ensureArea(rec.area, installationId, cache);

  const key = `${installationId}::${rec.tag.trim().toLowerCase()}`;
  const existing = catalog.confinedSpaces.find(
    (cs) => cs.installationId === installationId && cs.tag.trim().toLowerCase() === rec.tag.trim().toLowerCase(),
  );

  if (!existing) {
    if (REPORT_ONLY) {
      report.created.push({ tag: rec.tag, plan: 'would create fresh' });
      return;
    }
    console.log(`  -> espaço não existe, criando do zero`);
    // Same "create fresh" path as migrate.js.
    const cs = unwrap(
      await client.post('/confined-spaces/create', {
        unityId: UNITY_ID, installationId, areaId, name: rec.name, type: rec.type, tag: rec.tag,
      }),
      `create confined space ${rec.tag}`,
    );
    lastConfinedSpaceId = cs.id;
    // Rollback for a space created in this run is a full deactivation
    // (isActive: false) - there is no hard-delete endpoint for confined
    // spaces, and deactivating is the same reversible action a manager
    // would take from the UI, so it keeps the audit trail intact.
    journalPush({ action: 'create_confined_space', confinedSpaceId: cs.id, tag: rec.tag, name: rec.name });
    await publishGeneral(cs.id, rec, null);
    await publishVentilation(cs.id, rec);
    await linkRescue(cs.id, rec, catalog, [], false);
    await attachManholePhotoIfMissing(cs.id, rec, true);
    report.created.push({ tag: rec.tag, id: cs.id });
    return;
  }

  // Space already exists - reconcile instead of overwrite.
  const confinedSpaceId = existing.id;
  lastConfinedSpaceId = confinedSpaceId;
  const publishedGeneral = unwrap(
    await client.get(`/confined-spaces/${confinedSpaceId}/forms/general`),
    `get general ${rec.tag}`,
  );
  const currentGeneral = (publishedGeneral && publishedGeneral.data) || {};
  const generalFill = buildFillPayload(currentGeneral, rec.general);
  const generalMismatches = findMismatches(currentGeneral, rec.general);

  const currentManholes = currentGeneral.manholes || [];
  let manholesToAdd = null;
  if (currentManholes.length === 0 && rec.manholes.length > 0) {
    manholesToAdd = rec.manholes;
  } else if (currentManholes.length > 0) {
    report.manholesSkipped.push({
      tag: rec.tag,
      reason: `already has ${currentManholes.length} manhole(s), spreadsheet implies ${rec.manholes.length} - not touched`,
    });
  }

  if (Object.keys(generalFill).length > 0 || manholesToAdd) {
    if (!REPORT_ONLY) {
      await publishGeneral(confinedSpaceId, rec, publishedGeneral.data.id, generalFill, manholesToAdd);
      if (Object.keys(generalFill).length > 0) {
        console.log(`  -> preenchendo campos (geral): ${Object.keys(generalFill).join(', ')}`);
        journalPush({ action: 'fill_general', confinedSpaceId, tag: rec.tag, fields: generalFill });
      }
    }
    report.filledGaps.push({ tag: rec.tag, section: 'general', fields: Object.keys(generalFill), manholesAdded: manholesToAdd ? manholesToAdd.length : 0 });
  }
  if (generalMismatches.length > 0) {
    report.mismatches.push({ tag: rec.tag, section: 'general', mismatches: generalMismatches });
  }

  if (rec.ventilation) {
    const publishedVent = unwrap(
      await client.get(`/confined-spaces/${confinedSpaceId}/forms/ventilation`),
      `get ventilation ${rec.tag}`,
    );
    const currentVent = (publishedVent && publishedVent.data) || {};
    const ventFill = buildFillPayload(currentVent, rec.ventilation);
    const ventMismatches = findMismatches(currentVent, rec.ventilation);
    if (Object.keys(ventFill).length > 0) {
      if (!REPORT_ONLY) {
        await publishVentilationFill(confinedSpaceId, ventFill);
        console.log(`  -> preenchendo campos (ventilação): ${Object.keys(ventFill).join(', ')}`);
        journalPush({ action: 'fill_ventilation', confinedSpaceId, tag: rec.tag, fields: ventFill });
      }
      report.filledGaps.push({ tag: rec.tag, section: 'ventilation', fields: Object.keys(ventFill) });
    }
    if (ventMismatches.length > 0) {
      report.mismatches.push({ tag: rec.tag, section: 'ventilation', mismatches: ventMismatches });
    }
  }

  const publishedRescue = unwrap(
    await client.get(`/confined-spaces/${confinedSpaceId}/forms/rescue`),
    `get rescue ${rec.tag}`,
  );
  const currentMethods = (publishedRescue && publishedRescue.data && publishedRescue.data.methods) || [];
  if (currentMethods.length === 0) {
    await linkRescue(confinedSpaceId, rec, catalog, currentMethods, true);
  } else {
    report.alreadyMatched.push({ tag: rec.tag, section: 'rescue', note: `already linked to "${currentMethods[0].name}"` });
  }

  if (Object.keys(generalFill).length === 0 && !manholesToAdd && generalMismatches.length === 0) {
    report.alreadyMatched.push({ tag: rec.tag, section: 'general', note: 'nothing to fill' });
  }

  await attachManholePhotoIfMissing(confinedSpaceId, rec, !!manholesToAdd);
}

// Uploads one image asset and attaches it to the given target. Shared by
// both the manhole-photo and general-space-photo attach steps below.
// targetVersion is required for space-level images (the backend's query for
// spaceImages filters by `entityVersion = general.version` - omitting it
// silently attaches the asset but it never shows up in the form); manhole
// images aren't filtered by version so it's harmless to pass there too.
async function uploadAndAttach(confinedSpaceId, rec, imageFile, subtype, targetType, targetId, targetCustomFieldKey, captionSuffix, targetVersion, caption) {
  const filePath = path.join(IMAGES_DIR, imageFile);
  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(imageFile).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';

  const init = unwrap(
    await client.post('/assets/upload/init', {
      ownerType: 'CONFINED_SPACE',
      ownerId: confinedSpaceId,
      category: 'CONFINED_SPACE_PHOTO',
      subtype,
      mimeType,
      sizeBytes: fileBuffer.length,
      originalFileName: imageFile,
    }),
    `init photo upload ${rec.tag} (${captionSuffix})`,
  );

  const putRes = await axios.put(init.uploadUrl, fileBuffer, {
    headers: init.requiredHeaders,
    validateStatus: () => true,
  });
  if (putRes.status >= 300) {
    throw new Error(`PUT to presigned URL failed [${putRes.status}] for ${rec.tag} (${captionSuffix})`);
  }

  unwrap(await client.post('/assets/upload/complete', { assetId: init.assetId }), `complete photo upload ${rec.tag} (${captionSuffix})`);

  const attached = unwrap(
    await client.patch('/assets/attach', {
      assetId: init.assetId,
      targetType,
      targetId,
      targetVersion,
      targetSection: 'general',
      targetCustomFieldKey,
      caption: caption || `Foto (planilha ADM #${rec.admNumeroCadastro})`,
      // The frontend's image gallery (GeneralImageGallery) reads the asset
      // id from targetMetaJson.assetId, not from the reference's own top-
      // level id - without this, it silently filters the image out and
      // shows the "no images" empty state even though the reference exists.
      targetMetaJson: { assetId: init.assetId },
    }),
    `attach photo ${rec.tag} (${captionSuffix})`,
  );
  return attached.referenceId;
}

// Attaches the confined space's photo (extracted from the spreadsheet's
// embedded "Foto" image) to (a) EVERY manhole's image slot (captioned "Boca
// de visita 1", "Boca de visita 2", ... by creation order - since the
// spreadsheet only has one photo per space, the same image is reused on
// each one), and (b) the confined space's own general "space image" slot -
// each manhole checked independently, only filling the ones that don't
// already have an image (never duplicates/overwrites an existing one).
// manholesWereAdded should be true whenever this call follows a
// publishGeneral() that just created new manholes (both the "fresh space"
// and "existing space with 0 manholes so far" paths always add manholes
// starting from zero) - it lets us journal exactly which manhole ids were
// created in this run, for a precise rollback.
async function attachManholePhotoIfMissing(confinedSpaceId, rec, manholesWereAdded) {
  const imageFile = IMAGE_MANIFEST[rec.admNumeroCadastro];
  if (!imageFile) return;

  const fresh = unwrap(
    await client.get(`/confined-spaces/${confinedSpaceId}/forms/general`),
    `get general for photo ${rec.tag}`,
  );
  const data = (fresh && fresh.data) || {};
  // The API does not guarantee stable ordering of the manholes array across
  // calls, so sort by createdAt (creation order) before numbering them -
  // otherwise "Boca de visita 1/2/3" captions could shuffle between runs.
  const manholes = [...(data.manholes || [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const spaceImages = data.spaceImages || [];

  if (manholesWereAdded && manholes.length > 0 && !REPORT_ONLY) {
    journalPush({ action: 'add_manholes', confinedSpaceId, tag: rec.tag, manholeIds: manholes.map((m) => m.id) });
    console.log(`  -> criadas ${manholes.length} boca(s) de visita`);
  }

  // (a) Manhole images: every manhole gets the same photo, captioned by its
  // position, unless it already has an image.
  for (let i = 0; i < manholes.length; i++) {
    const manhole = manholes[i];
    const caption = `Boca de visita ${i + 1}`;
    if (manhole.images && manhole.images.length > 0) {
      report.alreadyMatched.push({ tag: rec.tag, section: 'manhole-photo', note: `${caption} already has an image` });
    } else if (REPORT_ONLY) {
      report.filledGaps.push({ tag: rec.tag, section: 'manhole-photo', wouldAttach: `${imageFile} -> ${caption}` });
    } else {
      console.log(`  -> anexando foto: ${caption}`);
      const referenceId = await uploadAndAttach(confinedSpaceId, rec, imageFile, 'MANHOLE_IMAGE', 'MANHOLE', manhole.id, 'manholeImages', 'manhole', fresh.version, caption);
      journalPush({ action: 'attach_image', confinedSpaceId, tag: rec.tag, target: 'manhole', manholeId: manhole.id, referenceId, caption });
      report.filledGaps.push({ tag: rec.tag, section: 'manhole-photo', attached: `${imageFile} -> ${caption}` });
    }
  }

  // (b) General confined-space photo (independent of the manhole photo).
  if (spaceImages.length > 0) {
    report.alreadyMatched.push({ tag: rec.tag, section: 'space-photo', note: 'confined space already has a general image' });
  } else if (REPORT_ONLY) {
    report.filledGaps.push({ tag: rec.tag, section: 'space-photo', wouldAttach: imageFile });
  } else {
    console.log(`  -> anexando foto: espaço confinado (geral)`);
    const referenceId = await uploadAndAttach(confinedSpaceId, rec, imageFile, 'SPACE_IMAGE', 'CONFINED_SPACE', confinedSpaceId, 'spaceImages', 'space', fresh.version);
    journalPush({ action: 'attach_image', confinedSpaceId, tag: rec.tag, target: 'space', referenceId, caption: 'Foto do espaço confinado' });
    report.filledGaps.push({ tag: rec.tag, section: 'space-photo', attached: imageFile });
  }
}

async function publishGeneral(confinedSpaceId, rec, existingFormId, fillPayload, manholesToAdd) {
  const editRes = unwrap(
    await client.post(
      `/confined-spaces/${confinedSpaceId}/forms/general/edit`,
      existingFormId ? { formId: existingFormId } : {},
    ),
    `begin general edit ${rec.tag}`,
  );
  const lockSessionId = editRes.data.lockSessionId;
  const payload = fillPayload !== undefined ? { ...fillPayload } : { ...rec.general };
  if (manholesToAdd !== undefined && manholesToAdd !== null) {
    payload.manholes = manholesToAdd;
  } else if (fillPayload === undefined) {
    payload.manholes = rec.manholes;
  }
  unwrap(
    await client.put(`/confined-spaces/${confinedSpaceId}/forms/general/draft`, { lockSessionId, ...payload }),
    `save general draft ${rec.tag}`,
  );
  unwrap(
    await client.post(`/confined-spaces/${confinedSpaceId}/forms/general/publish`, {}),
    `publish general ${rec.tag}`,
  );
}

async function publishVentilation(confinedSpaceId, rec) {
  if (!rec.ventilation) return;
  unwrap(
    await client.put(`/confined-spaces/${confinedSpaceId}/forms/ventilation/draft`, rec.ventilation),
    `save ventilation draft ${rec.tag}`,
  );
  unwrap(
    await client.post(`/confined-spaces/${confinedSpaceId}/forms/ventilation/publish`, {}),
    `publish ventilation ${rec.tag}`,
  );
}

async function publishVentilationFill(confinedSpaceId, fillPayload) {
  unwrap(
    await client.put(`/confined-spaces/${confinedSpaceId}/forms/ventilation/draft`, fillPayload),
    `save ventilation fill draft ${confinedSpaceId}`,
  );
  unwrap(
    await client.post(`/confined-spaces/${confinedSpaceId}/forms/ventilation/publish`, {}),
    `publish ventilation fill ${confinedSpaceId}`,
  );
}

// Rescue methods are expected to already exist in production's catalog -
// this NEVER creates one. Matching is tolerant of case/whitespace, and
// falls back to a substring match (e.g. catalog name "Resgate Suspenso -
// Tipo 04" vs spreadsheet-derived "TIPO DE RESGATE 04 (Suspenso)") since the
// exact wording in production may differ from what was parsed out of the
// spreadsheet. Fuzzy matches are flagged in the report for manual review -
// never silently trusted.
function normalizeName(v) {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

function findCatalogMatch(catalogMethods, targetName) {
  const target = normalizeName(targetName);
  const exact = catalogMethods.find((m) => normalizeName(m.name) === target);
  if (exact) return { method: exact, fuzzy: false };

  const targetWords = target.match(/\d+|terrestre|suspenso/gi) || [];
  if (targetWords.length) {
    const fuzzy = catalogMethods.find((m) => {
      const name = normalizeName(m.name);
      return targetWords.every((w) => name.includes(w.toLowerCase()));
    });
    if (fuzzy) return { method: fuzzy, fuzzy: true };
  }
  return { method: null, fuzzy: false };
}

// recordJournal should be false when this is part of creating a brand new
// confined space (rolling back the space itself, via deactivation, already
// undoes the rescue link with it) and true when linking rescue onto a
// pre-existing space (needs its own journal entry so rollback can unlink
// just this, without touching the rest of the space).
async function linkRescue(confinedSpaceId, rec, catalog, currentMethods, recordJournal) {
  const targetName = DATA.rescueMethods.find((m) => m.key === rec.rescueKey).name;
  const { method: catalogMethod, fuzzy } = findCatalogMatch(catalog.rescueMethods, targetName);

  if (!catalogMethod) {
    report.rescueCatalogMissing.push({ tag: rec.tag, expectedName: targetName });
    return;
  }
  if (fuzzy) {
    report.mismatches.push({
      tag: rec.tag,
      section: 'rescue-fuzzy-match',
      mismatches: [{ field: 'rescueMethodName', current: catalogMethod.name, spreadsheet: targetName }],
    });
  }
  if (currentMethods.some((m) => m.rescueMethodId === catalogMethod.id)) {
    return; // already linked to the right one
  }
  if (REPORT_ONLY) {
    report.filledGaps.push({ tag: rec.tag, section: 'rescue', wouldLink: targetName });
    return;
  }
  console.log(`  -> vinculando resgate: ${catalogMethod.name}${fuzzy ? ' (match aproximado - revisar)' : ''}`);
  unwrap(
    await client.put(`/confined-spaces/${confinedSpaceId}/forms/rescue/draft`, {
      methods: [{ rescueMethodId: catalogMethod.id, notes: rec.linkResgate ? `Link de Resgate: ${rec.linkResgate}` : undefined }],
    }),
    `save rescue draft ${rec.tag}`,
  );
  unwrap(
    await client.post(`/confined-spaces/${confinedSpaceId}/forms/rescue/publish`, {}),
    `publish rescue ${rec.tag}`,
  );
  if (recordJournal) {
    journalPush({ action: 'link_rescue', confinedSpaceId, tag: rec.tag, rescueMethodId: catalogMethod.id, rescueMethodName: catalogMethod.name });
  }
  report.filledGaps.push({ tag: rec.tag, section: 'rescue', linked: targetName });
}

// Best-effort cleanup after a failed record: discards any dangling draft
// (general/ventilation/rescue) left in EDITING status on this confined
// space by the attempt that just failed, so it doesn't sit around forever
// un-published and un-discarded. Discarding is safe even if there's nothing
// to discard (the endpoint 404s/400s, which we just ignore) - never treated
// as fatal, since this is cleanup on top of an already-failed record.
async function discardStaleDraftsIfAny(confinedSpaceId, tag) {
  if (!confinedSpaceId || REPORT_ONLY) return;
  for (const formType of ['general', 'ventilation', 'rescue']) {
    try {
      const res = await client.post(`/confined-spaces/${confinedSpaceId}/forms/${formType}/discard`, {});
      if (res.status < 400) {
        console.log(`  -> rascunho de "${formType}" descartado após falha (${tag})`);
      }
      // 4xx here just means there was no dangling draft to discard - fine.
    } catch (err) {
      console.error(`  aviso: falha ao tentar descartar rascunho de "${formType}" (${tag}): ${err.message}`);
    }
  }
}

async function main() {
  console.log(`Modo: ${REPORT_ONLY ? 'SOMENTE RELATÓRIO (nada é gravado)' : 'GRAVAÇÃO REAL (LIVE)'}`);
  await login();
  const catalog = await loadCatalog();
  console.log(`Espaços confinados já existentes na unidade: ${catalog.confinedSpaces.length}`);
  console.log(`Métodos de resgate já existentes no catálogo: ${catalog.rescueMethods.length}`);
  console.log(`Total de registros a processar: ${DATA.confinedSpaces.length}\n`);

  const cache = { installations: {}, areas: {} };
  let i = 0;
  for (const rec of DATA.confinedSpaces) {
    i++;
    console.log(`[${i}/${DATA.confinedSpaces.length}] ${rec.tag} - ${rec.name}`);
    try {
      await reconcileConfinedSpace(rec, cache, catalog);
    } catch (err) {
      report.failed.push({ tag: rec.tag, admNumeroCadastro: rec.admNumeroCadastro, error: err.message });
      console.error(`  FALHOU: ${rec.tag} - ${err.message}`);
      await discardStaleDraftsIfAny(lastConfinedSpaceId, rec.tag);
    }
  }

  if (!REPORT_ONLY && journal.length > 0) {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2), 'utf-8');
    console.log(`\nJournal de alterações salvo em: ${JOURNAL_FILE}`);
    console.log(`Para reverter TUDO que este run fez, rode:`);
    console.log(`  node rollback.js "${JOURNAL_FILE}"`);
  }

  fs.writeFileSync(LOG_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log('\n--- Summary ---');
  console.log('Created:', report.created.length);
  console.log('Filled gaps:', report.filledGaps.length);
  console.log('Already matched (nothing to do):', report.alreadyMatched.length);
  console.log('Mismatches (existing data differs from spreadsheet, NOT overwritten):', report.mismatches.length);
  console.log('Rescue method missing from catalog:', report.rescueCatalogMissing.length);
  console.log('Manholes skipped (already had some):', report.manholesSkipped.length);
  console.log('Failed:', report.failed.length);
  console.log('Full report:', LOG_FILE);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

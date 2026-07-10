# -*- coding: utf-8 -*-
# Extracts embedded images from '2-Base de dados gerais' (Foto + Foto do
# Equip. Resgate columns), keyed by the row's "Numero do Cadastro" so they
# can be matched to a confined space by admNumeroCadastro.
import openpyxl, glob, sys, os, json
sys.stdout.reconfigure(encoding='utf-8')

folder = os.environ.get(
    "PLANILHAS_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "planilha adm"),
)
folder = os.path.abspath(folder)
files = glob.glob(os.path.join(folder, "*.xlsx"))
files = [f for f in files if "~$" not in f]
path2 = [f for f in files if "Invent" in f][0]

out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extracted_images")
os.makedirs(out_dir, exist_ok=True)

wb = openpyxl.load_workbook(path2)
ws = wb['2-Base de dados gerais']

# Column A (0-indexed col 0) holds "Numero do Cadastro" per row.
# Image anchors use 0-indexed rows; openpyxl's ws.cell() uses 1-indexed rows,
# so anchor row 4 (0-indexed) == Excel row 5 (1-indexed), the first data row.
def cadastro_for_row(row_idx_0based):
    excel_row_1indexed = row_idx_0based + 1
    cell = ws.cell(row=excel_row_1indexed, column=1)
    return cell.value

FOTO_COL = 8       # 0-indexed col for "Foto" (column I)
FOTO_RESGATE_COL = 42  # 0-indexed col for "Foto do Equip. Resgate" (column AQ)

manifest = []
for img in ws._images:
    anchor = img.anchor
    frm = anchor._from
    row0, col0 = frm.row, frm.col
    cadastro = cadastro_for_row(row0)
    if cadastro is None:
        continue
    try:
        cadastro_num = int(float(cadastro))
    except (TypeError, ValueError):
        continue

    if col0 == FOTO_COL:
        kind = 'foto_geral'
    elif col0 == FOTO_RESGATE_COL:
        kind = 'foto_resgate'
    else:
        continue  # not one of the two photo columns we care about

    ext = os.path.splitext(img.path)[1].lstrip('.') or 'jpg'
    if ext.lower() == 'mpo':
        ext = 'jpg'  # MPO (multi-picture, from some phone cameras) - save with .jpg, most viewers/PIL handle it as jpeg
    fname = f"{cadastro_num}_{kind}.{ext}"
    fpath = os.path.join(out_dir, fname)
    with open(fpath, 'wb') as f:
        f.write(img.ref.getvalue())
    manifest.append({'admNumeroCadastro': cadastro_num, 'kind': kind, 'file': fname})

with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

print(f"Extracted {len(manifest)} images to {out_dir}")
by_kind = {}
for m in manifest:
    by_kind[m['kind']] = by_kind.get(m['kind'], 0) + 1
print(by_kind)

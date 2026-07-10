# -*- coding: utf-8 -*-
import openpyxl, glob, sys, json, re, uuid, os
sys.stdout.reconfigure(encoding='utf-8')

# Pasta com as duas planilhas. Por padrao usa a mesma estrutura do Desktop
# ("planilha adm" ao lado desta pasta de scripts), mas pode ser sobrescrita
# com a variavel de ambiente PLANILHAS_DIR - util quando rodar em outra
# maquina/producao onde as planilhas estejam em outro lugar.
folder = os.environ.get(
    "PLANILHAS_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "planilha adm"),
)
folder = os.path.abspath(folder)

files = glob.glob(os.path.join(folder, "*.xlsx"))
files = [f for f in files if "~$" not in f]

path1_candidates = [f for f in files if "De-Para" in f]
path2_candidates = [f for f in files if "Invent" in f]

if not path1_candidates:
    raise FileNotFoundError(
        f"Nao achei a planilha 'De-Para ADM x Dino Classificado.xlsx' em: {folder}\n"
        f"Defina PLANILHAS_DIR apontando para a pasta correta."
    )
if not path2_candidates:
    raise FileNotFoundError(
        f"Nao achei a planilha 'Planilha Eletronica do Inventario de E.C.xlsx' em: {folder}\n"
        f"Defina PLANILHAS_DIR apontando para a pasta correta."
    )

path1 = path1_candidates[0]
path2 = path2_candidates[0]
print(f"Planilhas encontradas em: {folder}")
print(f"  De-Para: {os.path.basename(path1)}")
print(f"  Inventario: {os.path.basename(path2)}")

wb1 = openpyxl.load_workbook(path1, data_only=True)
ws1 = wb1['De-Para ADM x Dino']
wb2 = openpyxl.load_workbook(path2, data_only=True)
ws2 = wb2['2-Base de dados gerais']

def norm(v):
    if v is None: return None
    try: return int(float(str(v).strip()))
    except ValueError: return str(v).strip()

def s(v):
    if v is None: return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    v = str(v).strip()
    return v if v else None

def to_float(v):
    if v is None: return None
    try: return float(str(v).replace(',', '.').strip())
    except ValueError: return None

base_by_num = {}
for r in range(5, ws2.max_row + 1):
    num = ws2.cell(row=r, column=1).value
    if num is None: continue
    base_by_num[norm(num)] = [ws2.cell(row=r, column=c).value for c in range(1, 44)]

COL = {
    'empresa': 2, 'data_revisao': 3, 'elaborado_por': 4, 'nome_ec': 5,
    'numero_ec': 6, 'responsavel_tecnico': 7, 'local_area': 8, 'foto': 9,
    'link_fotos': 10, 'tipo_ec': 11, 'situacao': 12, 'formato_geometrico': 13,
    'material_construido': 14, 'material_armazenado': 15, 'area_classificada': 16,
    'diametro': 17, 'altura': 18, 'largura': 19, 'comprimento': 20, 'volume': 21,
    'localizacao_bv': 22, 'qtd_bv': 23, 'tamanho_bv': 24, 'bv_600mm': 25,
    'tipo_iluminacao': 26, 'acesso_externo': 27, 'situacao_acesso_ext': 28,
    'recomendacao_acesso_ext': 29, 'acesso_interno': 30, 'situacao_acesso_int': 31,
    'recomendacao_acesso_int': 32, 'riscos_local': 33, 'atividades_rotineiras': 34,
    'riscos_atividade': 35, 'bloqueio': 36, 'monitoramento': 37, 'ventilacao': 38,
    'instalacao_poanco': 39, 'sistema_resgate': 40, 'plano_salvamento': 41,
    'link_resgate': 42, 'foto_equip_resgate': 43,
}

def get(base, key):
    idx = COL[key] - 1
    return base[idx] if idx < len(base) else None

RESCUE_METHODS = {}
def rescue_key_for(poanco, sistema):
    poanco_n = (poanco or '').strip()
    sistema_n = (sistema or '').strip()
    return (poanco_n, sistema_n)

records = []
for r in range(2, ws1.max_row + 1):
    status = ws1.cell(row=r, column=1).value
    if not status or str(status).strip().lower() != 'verde':
        continue
    inst = s(ws1.cell(row=r, column=2).value)
    area = s(ws1.cell(row=r, column=3).value)
    tag = s(ws1.cell(row=r, column=4).value)
    name = s(ws1.cell(row=r, column=5).value)
    adm_num = norm(ws1.cell(row=r, column=6).value)

    base = base_by_num.get(adm_num)
    if base is None:
        continue

    situacao = s(get(base, 'situacao'))
    is_active = None
    if situacao:
        low = situacao.strip().lower()
        if low == 'ativo': is_active = True
        elif low in ('desativado', 'inativo'): is_active = False

    area_classificada = s(get(base, 'area_classificada'))
    hazardous_area = area_classificada.strip().lower() == 'sim' if area_classificada else None

    acesso_interno = s(get(base, 'acesso_interno'))
    acesso_externo = s(get(base, 'acesso_externo'))
    formato_geometrico = s(get(base, 'formato_geometrico'))
    tipo_iluminacao = s(get(base, 'tipo_iluminacao'))

    # --- Disposição (Vertical/Horizontal): a planilha não tem essa coluna
    # diretamente, mas dá pra derivar com segurança a partir de Altura vs
    # Comprimento - se tem Altura, o equipamento está em pé (Vertical); se
    # não tem Altura mas tem Comprimento, está deitado (Horizontal).
    altura_raw = get(base, 'altura')
    comprimento_raw = get(base, 'comprimento')
    altura_val = to_float(altura_raw)
    comprimento_val = to_float(comprimento_raw)
    if altura_val is not None:
        disposicao = 'Vertical'
    elif comprimento_val is not None:
        disposicao = 'Horizontal'
    else:
        disposicao = 'Vertical'

    # --- Local: cópia direta da coluna "Local ou Área" da planilha (ex.:
    # "Fábrica 1 / Externa") - já vem pronta, não precisa derivar nada.
    local_field = s(get(base, 'local_area'))

    # --- Possui escada?: checar tanto Acesso Interno quanto Acesso Externo -
    # ex.: "Acesso Externo: Escada 90º" também conta como "tem escada", não
    # só quando a escada está descrita no acesso interno.
    has_ladder = any(
        v and 'escada' in v.lower()
        for v in (acesso_interno, acesso_externo)
    ) or None

    # --- Bocas de Visita: algumas linhas descrevem mais de uma BV na mesma
    # célula, separadas por "/", ", " ou " e " (ex.: "Superior / Lateral
    # Inferior" com tamanho "0.47 x 0.47 / 0.50 x 0.50"). Cada uma vira uma
    # entrada própria no array manholes, exatamente como o editor faria ao
    # clicar em "adicionar boca de visita" várias vezes.
    SPLIT_RE = re.compile(r'\s*/\s*|\s*,\s*|\s+e\s+', re.IGNORECASE)

    def split_list(v):
        if not v:
            return []
        parts = [p.strip() for p in SPLIT_RE.split(v.strip()) if p.strip()]
        return parts

    localizacao_raw = s(get(base, 'localizacao_bv'))
    tamanho_raw = s(get(base, 'tamanho_bv'))
    qtd_raw = get(base, 'qtd_bv')
    try:
        qtd_n = int(float(qtd_raw)) if qtd_raw is not None else None
    except (TypeError, ValueError):
        qtd_n = None

    localizacoes = split_list(localizacao_raw)
    tamanhos = split_list(tamanho_raw)
    n_manholes = max(len(localizacoes), len(tamanhos), qtd_n or 0, 1 if (localizacao_raw or tamanho_raw) else 0)

    def pick(lst, i):
        if not lst:
            return None
        return lst[i] if i < len(lst) else lst[-1]

    manholes = []
    for i in range(n_manholes):
        acc = acesso_interno
        manholes.append({
            'manholeDimension': pick(tamanhos, i) or tamanho_raw,
            'access': acc,
            'hasLadder': has_ladder,
            'observationsComments': pick(localizacoes, i) or localizacao_raw,
        })

    # --- Campos Customizados: o frontend só renderiza customFieldsJson.blocks
    # (um array de blocos {id, type:"field", content:{label, value}}), não um
    # dicionário simples de chave/valor - foi por isso que o que eu tinha
    # posto antes ficava invisível na tela. Só os 4 campos pedidos.
    def field_block(label, value):
        if not value:
            return None
        return {
            'id': str(uuid.uuid4()),
            'type': 'field',
            'content': {'label': label, 'value': str(value)},
        }

    custom_blocks = [
        b for b in [
            field_block('Formato Geométrico', formato_geometrico),
            field_block('Tipo de Iluminação', tipo_iluminacao),
            field_block('Acesso Externo', acesso_externo),
            field_block('Acesso Interno', acesso_interno),
        ] if b is not None
    ]

    # --- Ventilação: parse the free-text paragraph into the form's real
    # engineering fields where the numbers are actually present in the text,
    # keep the original text as generalObservations/observations so nothing
    # is lost even when there is nothing numeric to extract.
    ventilacao_text = s(get(base, 'ventilacao'))
    ventilation = None
    if ventilacao_text:
        flow_match = re.search(r'Vaz[aã]o de\s*([\d.,]+)\s*m', ventilacao_text, re.IGNORECASE)
        ach_match = re.search(r'Troca de ar recomendadas? por hora:?\s*([\d.,]+)', ventilacao_text, re.IGNORECASE)
        fan_match = re.search(r'Ventilador\s+([^\n;]+)', ventilacao_text, re.IGNORECASE)
        mode_match = re.search(r'(Natural[^\n.;]*Mec[aâ]nica|Mec[aâ]nica|Natural)', ventilacao_text, re.IGNORECASE)

        ventilation = {
            'spaceVolumeM3': to_float(get(base, 'volume')),
            'requiredFlowRateM3h': to_float(flow_match.group(1).replace('.', '').replace(',', '.')) if flow_match else None,
            # "Troca de ar recomendadas por hora" = renovações por hora
            # considerando a seleção do GDV -> gdvEffectiveAirChangesPerHour,
            # não targetAirChangesPerHour (que é outro conceito). Explicitly
            # null (not omitted) to clear the earlier wrong value on overwrite.
            'targetAirChangesPerHour': None,
            'gdvEffectiveAirChangesPerHour': to_float(ach_match.group(1)) if ach_match else None,
            'gdvFunctionMode': (fan_match.group(1).strip() if fan_match else None),
            'auxEnabled': bool(mode_match and 'mec' in mode_match.group(1).lower()),
            'generalObservations': ventilacao_text[:2000],
        }

    # --- Energias Perigosas: deixado em branco por enquanto (a pedido).
    hazardous_energy = None

    poanco = s(get(base, 'instalacao_poanco'))
    sistema = s(get(base, 'sistema_resgate'))
    plano = s(get(base, 'plano_salvamento'))
    rkey = rescue_key_for(poanco, sistema)
    if rkey not in RESCUE_METHODS:
        # derive a short name from the "TIPO DE RESGATE XX (...)" first line of plano
        first_line = (plano or '').split('\n')[0].strip() if plano else f"Resgate {len(RESCUE_METHODS)+1}"
        def one_line(v):
            if not v:
                return ''
            return ' '.join(v.split())

        desc = f"POAnco: {one_line(poanco)} | Sistema: {one_line(sistema)}"
        if len(desc) > 250:
            desc = desc[:247] + '...'

        # Full text (POAnco + Sistema + the complete step-by-step plano,
        # phone numbers included) is preserved in customFieldsJson.blocks -
        # description alone is too short (varchar 255) to hold it all.
        blocks = []
        if poanco:
            blocks.append({'type': 'text', 'title': 'Instalação de POAnco', 'content': poanco})
        if sistema:
            blocks.append({'type': 'text', 'title': 'Sistema de Resgate', 'content': sistema})
        if plano:
            blocks.append({'type': 'text', 'title': 'Plano de Salvamento e Resgate', 'content': plano})

        RESCUE_METHODS[rkey] = {
            'key': f"R{len(RESCUE_METHODS)+1}",
            'name': first_line or f"Resgate {len(RESCUE_METHODS)+1}",
            'description': desc,
            'customFieldsJson': {'blocks': blocks} if blocks else None,
        }

    record = {
        'admNumeroCadastro': adm_num,
        'installation': inst,
        'area': area,
        'tag': tag,
        'name': name,
        'type': 'EC',
        'rescueKey': RESCUE_METHODS[rkey]['key'],
        'linkResgate': s(get(base, 'link_resgate')),
        'general': {
            'equipment': s(get(base, 'tipo_ec')),
            'isActive': is_active,
            'disposition': disposicao,
            'local': local_field,
            'material': s(get(base, 'material_construido')),
            'productContaminant': s(get(base, 'material_armazenado')),
            'hazardousArea': hazardous_area,
            'diameterM': to_float(get(base, 'diametro')),
            'heightM': to_float(get(base, 'altura')),
            'widthM': to_float(get(base, 'largura')),
            'lengthM': to_float(get(base, 'comprimento')),
            'volumeM3': to_float(get(base, 'volume')),
            'manholeDimension': s(get(base, 'tamanho_bv')),
            'access': acesso_interno,
            'hasLadder': has_ladder,
            'referenceDocument': (s(get(base, 'link_fotos')) or '')[:250] or None,
            'customFieldsJson': {'blocks': custom_blocks} if custom_blocks else None,
        },
        'manholes': manholes,
        'ventilation': ventilation,
        'hazardousEnergy': hazardous_energy,
    }
    records.append(record)

# Safety net: MySQL varchar columns default to 255 chars; truncate any
# string field in 'general' that could overflow (shouldn't happen given
# the source data, but avoids a hard failure mid-migration).
for rec in records:
    for k, v in list(rec['general'].items()):
        if isinstance(v, str) and len(v) > 250:
            rec['general'][k] = v[:250]
    for m in rec['manholes']:
        for k, v in list(m.items()):
            if isinstance(v, str) and len(v) > 250:
                m[k] = v[:250]

print("Total records:", len(records))
print("Distinct rescue methods:", len(RESCUE_METHODS))
for k, v in RESCUE_METHODS.items():
    print(" -", v['key'], ':', v['name'])

out = {
    'unityName': 'campinas',
    'confinedSpaces': records,
    'rescueMethods': list(RESCUE_METHODS.values()),
}
out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "import_data.json")
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("Saved:", out_path)

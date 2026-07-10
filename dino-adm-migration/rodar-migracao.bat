@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Migracao ADM x Dino - Espacos Confinados
echo ============================================
echo.

if not exist "config.txt" (
    echo Primeira vez rodando aqui. Preciso de algumas informacoes.
    echo (elas ficam salvas em config.txt, ao lado deste .bat, para as proximas vezes)
    echo.
    set /p BASE_URL="URL da API (ex.: http://localhost:3000): "
    set /p MIGRATION_EMAIL="E-mail do manager: "
    set /p MIGRATION_PASSWORD="Senha do manager: "
    set /p CLIENT_NAME="Nome do cliente/tenant (ex.: Archer Daniels Midland): "
    set /p UNITY_NAME="Nome da unidade (ex.: Sao Lourenco da Mata): "
    (
        echo BASE_URL=!BASE_URL!
        echo MIGRATION_EMAIL=!MIGRATION_EMAIL!
        echo MIGRATION_PASSWORD=!MIGRATION_PASSWORD!
        echo CLIENT_NAME=!CLIENT_NAME!
        echo UNITY_NAME=!UNITY_NAME!
    ) > config.txt
    echo.
    echo Configuracao salva em config.txt.
    echo.
)

for /f "tokens=1,* delims==" %%A in (config.txt) do set %%A=%%B

echo Rodando com:
echo   BASE_URL=%BASE_URL%
echo   MIGRATION_EMAIL=%MIGRATION_EMAIL%
echo   CLIENT_NAME=%CLIENT_NAME%
echo   UNITY_NAME=%UNITY_NAME%
echo.

echo --------------------------------------------
echo PASSO 1: gerando import_data.json a partir das planilhas...
echo --------------------------------------------
python build_import_data.py
if errorlevel 1 (
    echo.
    echo ERRO ao ler as planilhas. Confira se as duas planilhas estao na pasta
    echo "planilha adm" ao lado desta pasta, ou defina PLANILHAS_DIR.
    pause
    exit /b 1
)

echo.
echo --------------------------------------------
echo PASSO 2: extraindo fotos embutidas na planilha...
echo --------------------------------------------
python extract_images.py

echo.
echo --------------------------------------------
echo PASSO 3: gerando relatorio (sem gravar nada ainda)...
echo --------------------------------------------
set RECONCILE_REPORT_ONLY=true
node reconcile.js
set RECONCILE_REPORT_ONLY=

echo.
echo ============================================
echo Relatorio gerado em reconcile_report.json
echo Abra esse arquivo e confira antes de continuar,
echo principalmente a secao "mismatches".
echo ============================================
echo.
set /p CONFIRMA="Digite SIM para gravar de verdade no Dino agora (ou qualquer outra tecla para cancelar): "
if /i not "%CONFIRMA%"=="SIM" (
    echo Cancelado. Nada foi gravado.
    pause
    exit /b 0
)

echo.
echo --------------------------------------------
echo PASSO 4: gravando de verdade no Dino...
echo --------------------------------------------
node reconcile.js

echo.
echo ============================================
echo Concluido! Veja reconcile_run.json para o resultado final.
echo.
echo Se precisar DESFAZER o que este run fez, um arquivo
echo migration_journal_....json foi salvo nesta pasta - rode:
echo   node rollback.js "migration_journal_....json"
echo (o nome exato do arquivo foi mostrado acima, apos "Journal de alteracoes salvo em:")
echo ============================================
pause

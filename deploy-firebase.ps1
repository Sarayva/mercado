# ==============================================================================
# Script de Deploy e Configuração Automática do Firebase - Meu Mercado PWA
# ==============================================================================
$ErrorActionPreference = "Stop"

$nodeDir = "$env:LOCALAPPDATA\Programs\nodejs"
$npmBin = "$env:APPDATA\npm"
$gitDir = "C:\Users\Sarayva\AppData\Local\Programs\Git\cmd"
$env:Path = "$nodeDir;$npmBin;$gitDir;$env:Path"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  MEU MERCADO - DEPLOY E CONFIGURACAO DO FIREBASE" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Verifica ou realiza login no Firebase (abre navegador para você autorizar em 1 clique)
Write-Host "[1/4] Verificando login no Firebase..." -ForegroundColor Yellow
try {
    npx --yes firebase-tools login
} catch {
    Write-Host "Erro durante o login. Verifique sua conexão." -ForegroundColor Red
    exit 1
}

# 2. Lista os projetos e associa
Write-Host ""
Write-Host "[2/4] Projetos disponiveis na sua conta:" -ForegroundColor Yellow
npx --yes firebase-tools projects:list

$projId = Read-Host "Digite o ID do seu projeto Firebase (ex: meu-mercado-123)"
if ($projId) {
    npx --yes firebase-tools use $projId
}

# 3. Secret da Chave de Visão
Write-Host ""
Write-Host "[3/4] Chave da API de Visao (Claude sk-ant... ou Gemini AIza...)" -ForegroundColor Yellow
$cadastrar = Read-Host "Deseja cadastrar/atualizar agora o segredo VISION_API_KEY? (s/n)"
if ($cadastrar -eq 's' -or $cadastrar -eq 'S') {
    npx --yes firebase-tools functions:secrets:set VISION_API_KEY
}

# 4. Deploy da Cloud Function e Regras do Firestore
Write-Host ""
Write-Host "[4/4] Fazendo deploy da Cloud Function analyzePriceTag e das regras do Firestore..." -ForegroundColor Yellow
npx --yes firebase-tools deploy --only functions,firestore:rules

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  DEPLOY CONCLUIDO COM SUCESSO!" -ForegroundColor Green
Write-Host "  Copie a URL gerada acima e cole nas configuracoes do app no celular." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Green

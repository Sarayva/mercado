# ==============================================================================
# Servidor Web Local para Testes no Celular - Meu Mercado PWA
# Nao requer Node.js, Python ou qualquer instalacao externa!
# ==============================================================================

$port = 8080
$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = Get-Location }

# Detecta o IP local da rede Wi-Fi para abrir no celular
$localIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { 
    $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notmatch '^169\.' 
} | Select-Object -First 1).IPAddress

if (-not $localIp) { $localIp = "127.0.0.1" }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")

# Tenta escutar na interface de rede para acesso pelo celular
$listeningOnNetwork = $false
try {
    $listener.Prefixes.Add("http://$localIp`:$port/")
    $listener.Start()
    $listeningOnNetwork = $true
} catch {
    # Caso necessite de URL ACL ou permissao, inicia com localhost
    if (-not $listener.IsListening) {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://localhost:$port/")
        $listener.Start()
    }
}

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  MEU MERCADO PWA - SERVIDOR LOCAL ATIVO!" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  No computador:   http://localhost:$port" -ForegroundColor Yellow
if ($listeningOnNetwork) {
    Write-Host "  No seu celular:  http://${localIp}:${port}" -ForegroundColor Green
} else {
    Write-Host "  No seu celular:  http://${localIp}:${port} (se der bloqueio de porta, execute o PowerShell como Admin)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Dica: Conecte o celular no mesmo Wi-Fi e acesse o link acima." -ForegroundColor Gray
Write-Host "  No Chrome/Safari, toque em 'Adicionar a tela de inicio' para instalar como PWA." -ForegroundColor Gray
Write-Host ""
Write-Host "  [Pressione Ctrl+C para encerrar o servidor]" -ForegroundColor DarkGray
Write-Host "------------------------------------------------------" -ForegroundColor DarkGray

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".ico"  = "image/x-icon"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $urlPath = $request.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($urlPath)) {
            $urlPath = "index.html"
        }

        # Sanitiza o caminho para evitar traversal
        $filePath = [System.IO.Path]::Combine($rootDir, $urlPath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))

        if (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $mime = $mimeTypes[$ext]
            if (-not $mime) { $mime = "application/octet-stream" }

            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $response.ContentType = $mime
            $response.ContentLength64 = $bytes.Length
            $response.AddHeader("Cache-Control", "no-cache")
            $response.AddHeader("Service-Worker-Allowed", "/")
            $response.AddHeader("Access-Control-Allow-Origin", "*")
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 - Nao Encontrado")
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }

        $response.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
}

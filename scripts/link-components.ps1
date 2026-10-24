# Deixa o Clipador instalado enxergar o Whisper e os modelos que já estão no vendor/ do
# projeto, sem baixar de novo nem ocupar espaço duas vezes: cria hard links em
# %APPDATA%\Clipador\components. Também copia o .env pra pasta de dados (o app instalado lê de lá).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\link-components.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path $env:APPDATA 'Clipador'
$dest = Join-Path $data 'components'

function Link-Tree($from, $to) {
  if (-not (Test-Path $from)) { Write-Output "sem $from (pulei)"; return }
  Get-ChildItem $from -Recurse -File | ForEach-Object {
    $target = Join-Path $to ($_.FullName.Substring($from.Length).TrimStart('\'))
    New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
    if (-not (Test-Path $target)) { New-Item -ItemType HardLink -Path $target -Target $_.FullName | Out-Null }
  }
  Write-Output "ok  $to"
}

Link-Tree (Join-Path $root 'vendor\whisper') (Join-Path $dest 'whisper')
Link-Tree (Join-Path $root 'vendor\models') (Join-Path $dest 'models')
$ytdlp = Join-Path $root 'vendor\yt-dlp.exe'
$ytdlpDst = Join-Path $dest 'yt-dlp.exe'
if ((Test-Path $ytdlp) -and -not (Test-Path $ytdlpDst)) {
  New-Item -ItemType HardLink -Path $ytdlpDst -Target $ytdlp | Out-Null
  Write-Output "ok  $ytdlpDst"
}

$envSrc = Join-Path $root '.env'
$envDst = Join-Path $data '.env'
if ((Test-Path $envSrc) -and -not (Test-Path $envDst)) {
  Copy-Item $envSrc $envDst
  Write-Output "ok  .env copiado pra $envDst"
} elseif (Test-Path $envDst) {
  Write-Output "já existe $envDst (não mexi; o app instalado usa esse)"
}

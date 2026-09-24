# Launch the DeepSeek Harness Web UI from the local source checkout.
# The repo at .\deepseek-harness is a read-only git clone: never write into it.
# Extra arguments are forwarded to `dsh web` (e.g. --no-open, --port 8080).
$repo = Join-Path $PSScriptRoot 'deepseek-harness'
$cli  = Join-Path $repo 'apps\cli\lib\bin.js'

if (-not (Test-Path $cli)) {
    Write-Error "dsh CLI not found at: $cli (is the deepseek-harness checkout present?)"
    exit 1
}

Set-Location $PSScriptRoot
node $cli web @args

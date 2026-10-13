# Generates a recipe thumbnail with Nano Banana (Gemini image model).
# Usage: gen-thumbnail.ps1 -OutPath <png path> -Prompt <english prompt> [-Model <model id>]
# Key: GEMINI_API_KEY env var, or env.GEMINI_API_KEY in .claude/settings.local.json. Keep prompts in English (PS 5.1 encoding).
param(
  [Parameter(Mandatory)][string]$OutPath,
  [Parameter(Mandatory)][string]$Prompt,
  [string]$Model = "gemini-2.5-flash-image",
  [string]$AspectRatio = "16:9"
)
$ErrorActionPreference = "Stop"
if (-not $env:GEMINI_API_KEY) {
  # scripts -> recipe-book -> skills -> .claude
  $settings = Join-Path $PSScriptRoot "..\..\..\settings.local.json"
  if (Test-Path $settings) {
    $env:GEMINI_API_KEY = (Get-Content $settings -Raw -Encoding UTF8 | ConvertFrom-Json).env.GEMINI_API_KEY
  }
}
if (-not $env:GEMINI_API_KEY -or $env:GEMINI_API_KEY -like "PASTE_*") {
  throw "GEMINI_API_KEY is not set (env var or .claude/settings.local.json env.GEMINI_API_KEY)"
}

$dir = Split-Path -Parent $OutPath
if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }

$body = @{
  contents = @(@{ parts = @(@{ text = $Prompt }) })
  generationConfig = @{ responseModalities = @("IMAGE"); imageConfig = @{ aspectRatio = $AspectRatio } }
} | ConvertTo-Json -Depth 10
$uri = "https://generativelanguage.googleapis.com/v1beta/models/$($Model):generateContent"
$resp = Invoke-RestMethod -Uri $uri -Method Post -Headers @{ "x-goog-api-key" = $env:GEMINI_API_KEY } -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))

$img = $resp.candidates[0].content.parts | Where-Object { $_.inlineData } | Select-Object -First 1
if (-not $img) { $resp | ConvertTo-Json -Depth 10; throw "No image returned" }
[IO.File]::WriteAllBytes($OutPath, [Convert]::FromBase64String($img.inlineData.data))
"Saved: $OutPath ($($img.inlineData.mimeType))"

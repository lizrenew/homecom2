param(
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$OutDir,
    [string]$Lang = 'ko',
    [switch]$NoVideo
)
# 유튜브 영상(선택)과 자막을 받아 OutDir에 저장하고, 자막 srt 경로를 마지막 줄에 출력한다.
$ErrorActionPreference = 'Stop'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
    throw "yt-dlp가 없습니다. 'winget install --id yt-dlp.yt-dlp -e' 로 설치하세요."
}
New-Item -ItemType Directory -Force $OutDir | Out-Null

# 1) 자막 종류 확인: 업로더 자막 > 자동 자막 원본(<lang>-orig) > 자동 자막(<lang>)
$list = (yt-dlp --list-subs --skip-download $Url 2>&1 | Out-String) -split "`n"
$manualIdx = [Array]::FindIndex($list, [Predicate[string]] { param($l) $l -match '^\[info\] Available subtitles' })
$autoIdx = [Array]::FindIndex($list, [Predicate[string]] { param($l) $l -match '^\[info\] Available automatic captions' })
function Has-Lang($start, $end, $code) {
    if ($start -lt 0) { return $false }
    for ($i = $start + 1; $i -lt $end; $i++) { if ($list[$i] -match "^$([regex]::Escape($code))\s") { return $true } }
    return $false
}
$autoEnd = if ($autoIdx -ge 0) { $list.Length } else { 0 }
$manualEnd = if ($manualIdx -ge 0 -and $autoIdx -gt $manualIdx) { $autoIdx } else { $list.Length }

$subArgs = $null
if (Has-Lang $manualIdx $manualEnd $Lang) { $subArgs = @('--write-subs', '--sub-langs', $Lang); $kind = "업로더 자막($Lang)" }
elseif (Has-Lang $autoIdx $autoEnd "$Lang-orig") { $subArgs = @('--write-auto-subs', '--sub-langs', "$Lang-orig"); $kind = "자동 자막($Lang-orig)" }
elseif (Has-Lang $autoIdx $autoEnd $Lang) { $subArgs = @('--write-auto-subs', '--sub-langs', $Lang); $kind = "자동 자막($Lang)" }
else { throw "'$Lang' 자막이 없습니다. --list-subs 결과를 확인하세요." }
Write-Host "자막: $kind"

# 2) 다운로드
$before = @(Get-ChildItem -LiteralPath $OutDir -Filter *.srt | ForEach-Object FullName)
$common = @('-P', $OutDir, '--no-progress', '--convert-subs', 'srt') + $subArgs
if ($NoVideo) { yt-dlp @common --skip-download $Url }
else { yt-dlp @common -f 'bv*+ba/b' --merge-output-format mp4 $Url }

$srt = Get-ChildItem -LiteralPath $OutDir -Filter *.srt | Where-Object { $before -notcontains $_.FullName } | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $srt) { $srt = Get-ChildItem -LiteralPath $OutDir -Filter *.srt | Sort-Object LastWriteTime | Select-Object -Last 1 }
Write-Host "SUBKIND=$kind"
Write-Output $srt.FullName

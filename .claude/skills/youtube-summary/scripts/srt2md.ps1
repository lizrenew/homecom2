param(
    [Parameter(Mandatory)][string]$SrtPath,
    [Parameter(Mandatory)][string]$OutPath,
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$Url,
    [string]$SubKind = '자동 생성 자막'
)
# srt 자막을 1분 단위 문단의 마크다운으로 변환한다. 자동 자막의 롤링 중복 줄은 제거한다.
$lines = Get-Content -LiteralPath $SrtPath -Encoding UTF8
$entries = New-Object System.Collections.Generic.List[object]
$cur = $null
foreach ($l in $lines) {
    if ($l -match '^(\d{2}):(\d{2}):(\d{2}),\d{3} -->') {
        $cur = [int]$matches[1] * 3600 + [int]$matches[2] * 60 + [int]$matches[3]
        continue
    }
    $t = $l.Trim()
    if ($t -eq '' -or $t -match '^\d+$' -or $null -eq $cur) { continue }
    $entries.Add(@($cur, $t))
}

# 롤링 자막 중복 제거: 직전 두 줄 중 하나와 같으면 건너뜀
# [ordered] 딕셔너리에 정수 키를 쓰면 순번 인덱스로 해석되므로 문자열 키를 쓴다
$seen = New-Object System.Collections.Generic.List[string]
$chunks = [ordered]@{}
foreach ($e in $entries) {
    $sec = $e[0]; $t = $e[1]
    if ($seen.Count -gt 0 -and $seen[$seen.Count - 1] -eq $t) { continue }
    if ($seen.Count -gt 1 -and $seen[$seen.Count - 2] -eq $t) { continue }
    $seen.Add($t)
    $key = [string][int][math]::Floor($sec / 60)
    if (-not $chunks.Contains($key)) { $chunks[$key] = New-Object System.Collections.Generic.List[string] }
    $chunks[$key].Add($t)
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# $Title")
[void]$sb.AppendLine()
[void]$sb.AppendLine("- 원본: $Url")
[void]$sb.AppendLine("- 자막: $SubKind 변환본 — 인식 오류가 있을 수 있음")
[void]$sb.AppendLine()
foreach ($k in @($chunks.Keys)) {
    $m = [int]$k
    $h = [int][math]::Floor($m / 60)
    if ($h -gt 0) { $stamp = '{0}:{1:D2}:00' -f $h, ($m % 60) } else { $stamp = '{0:D2}:00' -f $m }
    [void]$sb.AppendLine("## [$stamp]")
    [void]$sb.AppendLine()
    [void]$sb.AppendLine(($chunks[$k] -join ' '))
    [void]$sb.AppendLine()
}
[IO.File]::WriteAllText($OutPath, $sb.ToString(), (New-Object Text.UTF8Encoding $false))
Write-Output $OutPath

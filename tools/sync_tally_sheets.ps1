<#
  sync_tally_sheets.ps1 -- RES-EVO Billing Platform helper (runs on apt-pc)

  Copies each pad's "<Operator> - <Pad> - Tally Sheet.pdf" out of its cert-pack zip in
      RES Dropbox\RES Main\Evolution Well Services\_Pad Certs
  into Google Drive > EWS Billing > _Tally Sheets (work account, via Drive for Desktop).
  The billing site's "Email Draft" attaches it to every 755 Equipment Service PO Request
  and Invoice draft (Chad, 2026-10-31).

  - Read-only on Dropbox. Also picks up tally sheets sitting in unzipped pad folders.
  - Two packs for one pad (e.g. "EQT - Polecat.zip" + "EQT - Polecat - Updated 10.7.26.zip"):
    the most recently modified one wins.
  - Online-only (not downloaded) zips are skipped unless -Hydrate (that downloads them).
  - Unchanged zips are not re-opened (state: %LOCALAPPDATA%\RES-EVO\tally_sync.json).
  - Log: %LOCALAPPDATA%\RES-EVO\tally_sync.log
  - Scheduled task "RES-EVO Tally Sheet Sync": at logon + every 15 minutes.
    Re-run tools\install_tally_sync.ps1 to (re)create it.

  Manual run:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\sync_tally_sheets.ps1 [-Hydrate] [-Force]
#>
param([switch]$Hydrate, [switch]$Force)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$Src  = Join-Path $env:USERPROFILE 'RES Dropbox\RES Main\Evolution Well Services\_Pad Certs'
$Work = Join-Path $env:LOCALAPPDATA 'RES-EVO'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$StatePath = Join-Path $Work 'tally_sync.json'
$LogPath   = Join-Path $Work 'tally_sync.log'
$OFFLINE   = 0x401000   # RECALL_ON_DATA_ACCESS | OFFLINE  = Dropbox "online-only"

function Log([string]$m){
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  Write-Output $line
}
if((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 512KB){
  $keep = Get-Content -LiteralPath $LogPath -Tail 2000; Set-Content -LiteralPath $LogPath -Value $keep -Encoding UTF8
}
function IsOnlineOnly($f){ return [bool]($f.Attributes.value__ -band $OFFLINE) }
function OutName([string]$leaf, [string]$srcBase){
  # The pad-cert-pack tool names it "<Operator> - <Pad> - Tally Sheet.pdf". A bare "Tally Sheet.pdf" takes the zip / folder name.
  if($leaf -match '^\s*tally\s*sheet\s*\.pdf$'){
    $b = ($srcBase -replace '\s*-\s*updated\b.*$', '').Trim()
    return "$b - Tally Sheet.pdf"
  }
  return ($leaf -replace '\s+\.pdf$', '.pdf').Trim()
}
function IsPdf([string]$path){
  $fs = [IO.File]::OpenRead($path)
  try{ $b = New-Object byte[] 5; [void]$fs.Read($b, 0, 5); return ([Text.Encoding]::ASCII.GetString($b) -eq '%PDF-') } finally { $fs.Dispose() }
}

# Drive for Desktop's letter can change -- find whichever drive holds My Drive\EWS Billing
$Billing = Get-PSDrive -PSProvider FileSystem | ForEach-Object { Join-Path $_.Root 'My Drive\EWS Billing' } |
           Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if(-not $Billing){ Log 'ERROR: "My Drive\EWS Billing" not found on any drive -- is Google Drive for Desktop running and signed in to the work account?'; exit 1 }
if(-not (Test-Path -LiteralPath $Src)){ Log "ERROR: $Src not found -- is Dropbox running?"; exit 1 }
$Dst = Join-Path $Billing '_Tally Sheets'
New-Item -ItemType Directory -Force -Path $Dst | Out-Null

# ---- state: zip signature -> tally entries found inside; output name -> source signature last written
$state = @{ zips = @{}; outputs = @{} }
if((Test-Path -LiteralPath $StatePath) -and -not $Force){
  try{
    $j = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if($j.zips){ foreach($p in $j.zips.PSObject.Properties){ $state.zips[$p.Name] = @{ sig = [string]$p.Value.sig; online = [bool]$p.Value.online; tallies = @($p.Value.tallies | Where-Object { $_ }) } } }
    if($j.outputs){ foreach($p in $j.outputs.PSObject.Properties){ $state.outputs[$p.Name] = [string]$p.Value } }
  } catch { Log "state file unreadable, rebuilding: $($_.Exception.Message)" }
}

# ---- candidates
$cands = New-Object System.Collections.ArrayList
$errors = 0
foreach($z in Get-ChildItem -LiteralPath $Src -Filter '*.zip' -File){
  $sig = "$($z.Length)|$($z.LastWriteTimeUtc.Ticks)"
  $cached = $state.zips[$z.FullName]
  $online = IsOnlineOnly $z
  if($cached -and $cached.sig -eq $sig -and -not ($cached.online -and ($Hydrate -or -not $online))){
    $tallies = $cached.tallies
  } elseif($online -and -not $Hydrate){
    if(-not ($cached -and $cached.sig -eq $sig)){ Log "skipped (online-only in Dropbox, run with -Hydrate to download): $($z.Name)" }
    $state.zips[$z.FullName] = @{ sig = $sig; online = $true; tallies = @() }
    continue
  } else {
    try{
      $za = [IO.Compression.ZipFile]::OpenRead($z.FullName)
      try{ $tallies = @($za.Entries | Where-Object { $_.Name -match 'tally\s*sheet.*\.pdf$' -and $_.FullName -notmatch '(^|/)(OLD/|_)' } | Sort-Object { $_.FullName.Length } | ForEach-Object { $_.FullName }) }
      finally { $za.Dispose() }
      $state.zips[$z.FullName] = @{ sig = $sig; online = $false; tallies = $tallies }
      if(-not $tallies.Count){ Log "no tally sheet inside: $($z.Name)" }
    } catch { Log "ERROR reading $($z.Name): $($_.Exception.Message)"; $errors++; continue }
  }
  foreach($t in $tallies){
    [void]$cands.Add(@{ out = (OutName ($t.Split('/')[-1]) $z.BaseName); src = $z.FullName; entry = $t; mtime = $z.LastWriteTimeUtc; sig = "$sig|$t" })
  }
}
# unzipped pad folders (e.g. "EOG - Lloyd Smith - Emergency Service"); skips _Cert Pack Tools, _Pad Photos, OLD
foreach($d in Get-ChildItem -LiteralPath $Src -Directory | Where-Object { $_.Name -notmatch '^(_|OLD$)' }){
  foreach($f in Get-ChildItem -LiteralPath $d.FullName -Recurse -File -Filter '*Tally Sheet*.pdf' -ErrorAction SilentlyContinue){
    if((IsOnlineOnly $f) -and -not $Hydrate){ continue }
    [void]$cands.Add(@{ out = (OutName $f.Name $d.Name); src = $f.FullName; entry = $null; mtime = $f.LastWriteTimeUtc; sig = "$($f.Length)|$($f.LastWriteTimeUtc.Ticks)" })
  }
}

# ---- newest source wins per output name
$best = @{}
foreach($c in $cands){ $k = $c.out.ToLower(); if(-not $best[$k] -or $c.mtime -gt $best[$k].mtime){ $best[$k] = $c } }

# ---- write
$wrote = 0; $same = 0
foreach($c in $best.Values){
  $target = Join-Path $Dst $c.out
  if(-not $Force -and $state.outputs[$c.out] -eq $c.sig -and (Test-Path -LiteralPath $target)){ $same++; continue }
  $tmp = Join-Path $Work ('tally_' + [guid]::NewGuid().ToString('N') + '.pdf')
  try{
    if($c.entry){
      $za = [IO.Compression.ZipFile]::OpenRead($c.src)
      try{ [IO.Compression.ZipFileExtensions]::ExtractToFile($za.GetEntry($c.entry), $tmp, $true) } finally { $za.Dispose() }
    } else { Copy-Item -LiteralPath $c.src -Destination $tmp -Force }
    if(-not (IsPdf $tmp)){ Log "ERROR not a PDF, not copied: $($c.entry) in $(Split-Path $c.src -Leaf)"; $errors++; continue }
    $changed = -not (Test-Path -LiteralPath $target) -or ((Get-FileHash -LiteralPath $tmp).Hash -ne (Get-FileHash -LiteralPath $target).Hash)
    if($changed){ Copy-Item -LiteralPath $tmp -Destination $target -Force; Log "updated: $($c.out)  <-  $(Split-Path $c.src -Leaf)"; $wrote++ } else { $same++ }
    $state.outputs[$c.out] = $c.sig
  } catch { Log "ERROR writing $($c.out): $($_.Exception.Message)"; $errors++ }
  finally { if(Test-Path -LiteralPath $tmp){ Remove-Item -LiteralPath $tmp -Force } }
}

# forget zips that no longer exist
foreach($k in @($state.zips.Keys)){ if(-not (Test-Path -LiteralPath $k)){ $state.zips.Remove($k) } }
$state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StatePath -Encoding UTF8

$summary = "tally sync: $wrote updated, $same unchanged, $($best.Count) pads with a tally sheet, $errors error(s) -> $Dst"
if($wrote -or $errors){ Log $summary } else { Write-Output $summary }
if($errors){ exit 2 }

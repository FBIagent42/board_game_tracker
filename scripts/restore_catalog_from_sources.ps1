param(
  [int]$CollectionUserId = 1,
  [switch]$SkipGameRows,
  [switch]$SkipCollectionFix
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
$publicConfig = Get-Content (Join-Path $root 'config.public.json') -Raw | ConvertFrom-Json
$secretConfig = Get-Content (Join-Path $root 'config.secret.json') -Raw | ConvertFrom-Json
$supabaseUrl = ([string]$publicConfig.SUPABASE_URL).TrimEnd('/')
$serviceKey = [string]$secretConfig.SUPABASE_SERVICE_KEY
if (-not $supabaseUrl -or -not $serviceKey) {
  throw 'SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from config files.'
}

$headers = @{
  apikey = $serviceKey
  Authorization = "Bearer $serviceKey"
}

function Send-RestBatch([string]$table, [string]$conflict, [object[]]$rows, [bool]$ignoreDuplicates = $false) {
  if ($rows.Count -eq 0) { return }
  $preference = if ($ignoreDuplicates) { 'resolution=ignore-duplicates,return=minimal' } else { 'resolution=merge-duplicates,return=minimal' }
  $requestHeaders = $headers.Clone()
  $requestHeaders['Prefer'] = $preference
  $json = ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $uri = "$supabaseUrl/rest/v1/$table`?on_conflict=$conflict"
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Invoke-RestMethod -Uri $uri -Method Post -Headers $requestHeaders -ContentType 'application/json; charset=utf-8' -Body $bodyBytes | Out-Null
      return
    } catch {
      if ($attempt -eq 5) { throw }
      Start-Sleep -Seconds ([Math]::Min(30, 2 * $attempt))
    }
  }
}

function Convert-GameRow($row) {
  $record = [ordered]@{ game_id = [long]$row.game_id }
  $integerFields = @('year_published','min_players','max_players','manufacturer_playtime','community_min_playtime','community_max_playtime','manufacturer_age_rec')
  $numberFields = @('game_weight','avg_rating','bayes_avg_rating','community_age_rec')
  foreach ($field in $row.PSObject.Properties.Name) {
    if ($field -eq 'game_id' -or [string]::IsNullOrWhiteSpace([string]$row.$field)) { continue }
    if ($field -eq 'is_expansion') {
      $record[$field] = ([string]$row.$field).Trim().ToLowerInvariant() -eq 'true'
    } elseif ($field -in $integerFields) {
      $record[$field] = [long][double]$row.$field
    } elseif ($field -in $numberFields) {
      $record[$field] = [double]::Parse([string]$row.$field, [Globalization.CultureInfo]::InvariantCulture)
    } else {
      $record[$field] = [string]$row.$field
    }
  }
  if (-not $record.Contains('name')) { throw "Game $($row.game_id) has no name." }
  return [PSCustomObject]$record
}

$gameCount = 0
$seenIds = [System.Collections.Generic.HashSet[string]]::new()
if (-not $SkipGameRows) {
  $gameCsv = Join-Path $data 'games_merged.csv'
  $gameBatches = @{}
  $batchCount = 0
  foreach ($row in Import-Csv $gameCsv) {
    if (-not $seenIds.Add([string]$row.game_id)) { throw "Duplicate game_id $($row.game_id) in games_merged.csv." }
    $record = Convert-GameRow $row
    $signature = $record.PSObject.Properties.Name -join ','
    if (-not $gameBatches.ContainsKey($signature)) {
      $gameBatches[$signature] = [System.Collections.Generic.List[object]]::new()
    }
    $gameBatches[$signature].Add($record)
    if ($gameBatches[$signature].Count -ge 500) {
      Send-RestBatch 'game' 'game_id' $gameBatches[$signature].ToArray()
      $gameCount += $gameBatches[$signature].Count
      $batchCount++
      $gameBatches[$signature].Clear()
      if ($batchCount % 20 -eq 0) { Write-Host "Game rows restored: $gameCount" }
    }
  }
  foreach ($signature in $gameBatches.Keys) {
    if ($gameBatches[$signature].Count) {
      Send-RestBatch 'game' 'game_id' $gameBatches[$signature].ToArray()
      $gameCount += $gameBatches[$signature].Count
      $batchCount++
      if ($batchCount % 20 -eq 0) { Write-Host "Game rows restored: $gameCount" }
    }
  }
  Write-Host "Game rows restored: $gameCount"
}

# Restore collection references which were remapped from a deleted BGG ID.
$collectionFixCount = 0
if (-not $SkipCollectionFix) {
$rollbackMapPath = Join-Path $data 'name_deduplication_rollback_map.csv'
$collectionPath = Join-Path $data 'collection.csv'
$removedToRetained = @{}
foreach ($item in Import-Csv $rollbackMapPath) {
  $removedToRetained[[string]$item.removed_game_id] = [string]$item.retained_game_id
}
$sourceCollection = @(Import-Csv $collectionPath | Where-Object { $removedToRetained.ContainsKey([string]$_.objectid) })
$sourceIds = @{}
foreach ($item in Import-Csv $collectionPath) { $sourceIds[[string]$item.objectid] = $true }
foreach ($item in $sourceCollection) {
  $removedId = [string]$item.objectid
  $retainedId = $removedToRetained[$removedId]
  if ($sourceIds.ContainsKey($retainedId)) {
    throw "Collection contains both game IDs $removedId and $retainedId; review the play-count split before restoring."
  }
  $lookupUri = "$supabaseUrl/rest/v1/user_collection?select=user_id,game_id&user_id=eq.$CollectionUserId&game_id=eq.$retainedId&limit=2"
  $existing = @(Invoke-RestMethod -Uri $lookupUri -Method Get -Headers $headers)
  if ($existing.Count -gt 1) { throw "Multiple collection rows found for user $CollectionUserId and game $retainedId." }
  if ($existing.Count -eq 0) { continue }
  $patchUri = "$supabaseUrl/rest/v1/user_collection?user_id=eq.$CollectionUserId&game_id=eq.$retainedId"
  $patchHeaders = $headers.Clone()
  $patchHeaders['Prefer'] = 'return=minimal'
  Invoke-RestMethod -Uri $patchUri -Method Patch -Headers $patchHeaders -ContentType 'application/json' -Body (@{ game_id = [long]$removedId } | ConvertTo-Json -Compress) | Out-Null
  $collectionFixCount++
  Write-Host "Restored collection reference $retainedId -> $removedId ($($item.objectname), $($item.yearpublished))."
}
}

Write-Host "Catalog restoration complete. Game rows sent: $gameCount; collection references restored: $collectionFixCount"

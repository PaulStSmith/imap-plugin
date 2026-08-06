param(
  [string] $SiteName = "IMAP Plugin MCP",
  [string] $Binding = "http/*:8088:",
  [string] $SourcePath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string] $PhysicalPath = $env:IMAP_PLUGIN_IIS_PHYSICAL_PATH,
  [string] $PublicBaseUrl = $env:IMAP_PLUGIN_PUBLIC_BASE_URL,
  [string] $SetupToken = $env:IMAP_PLUGIN_SETUP_TOKEN,
  [string] $SqlConnectionString = $env:IMAP_PLUGIN_SQL_CONNECTION_STRING,
  [string] $ConfigDir = $env:IMAP_PLUGIN_CONFIG_DIR
)

$ErrorActionPreference = "Stop"

if (-not $PhysicalPath) {
  $inetpubPath = Join-Path $env:SystemDrive "inetpub\imap-plugin-mcp"
  $repoDeployPath = Join-Path $SourcePath ".iis-deploy"
  $PhysicalPath = if (Test-Path (Split-Path $inetpubPath -Parent)) { $inetpubPath } else { $repoDeployPath }
}

if (-not $PublicBaseUrl) {
  if ($Binding -match "^[^/]+/[^:]*:(\d+):") {
    $PublicBaseUrl = "http://localhost:$($Matches[1])"
  } else {
    $PublicBaseUrl = "http://localhost:8088"
  }
}

if (-not $SetupToken) {
  $SetupToken = "local-dev-setup-token"
}

$existingSqlConnectionString = $null
$existingConfigDir = $null
$existingWebConfigPath = Join-Path $PhysicalPath "web.config"
if ((-not $SqlConnectionString -or -not $ConfigDir) -and (Test-Path $existingWebConfigPath)) {
  try {
    [xml] $existingWebConfig = Get-Content $existingWebConfigPath
    if (-not $SqlConnectionString) {
      $existingSqlConnectionString = (
        $existingWebConfig.SelectNodes("//environmentVariable[@name='IMAP_PLUGIN_SQL_CONNECTION_STRING']") |
          Select-Object -First 1
      ).value
    }
    if (-not $ConfigDir) {
      $existingConfigDir = (
        $existingWebConfig.SelectNodes("//environmentVariable[@name='IMAP_PLUGIN_CONFIG_DIR']") |
          Select-Object -First 1
      ).value
    }
  } catch {
    Write-Warning "Could not read existing local plugin settings from $existingWebConfigPath. Continuing without preserving them."
  }
}

$appcmd = Join-Path $env:SystemRoot "System32\inetsrv\appcmd.exe"
if (-not (Test-Path $appcmd)) {
  throw "IIS appcmd.exe was not found. Install IIS before running this script."
}

if (-not (Test-Path (Join-Path $SourcePath "web.config"))) {
  throw "web.config was not found at $SourcePath."
}

if (-not (Test-Path (Join-Path $SourcePath "dist\server.js"))) {
  throw "dist\server.js was not found at $SourcePath. Run npm run build before running this script."
}

if (-not (Test-Path (Join-Path $SourcePath "node_modules"))) {
  throw "node_modules was not found at $SourcePath. Run npm install before running this script."
}

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $pnpm -and -not $npm) {
  throw "Neither pnpm nor npm was found. Install Node.js with npm before running this script."
}

$iisConfigDir = Join-Path $env:SystemRoot "System32\inetsrv\config"
$redirectionConfig = Join-Path $iisConfigDir "redirection.config"
$applicationHostConfig = Join-Path $iisConfigDir "applicationHost.config"
if (-not (Test-Path $redirectionConfig)) {
  throw "IIS redirection.config was not found at $redirectionConfig. Repair or reinstall IIS before running this script."
}

try {
  [System.IO.File]::OpenRead($redirectionConfig).Dispose()
} catch {
  throw "IIS configuration is not readable from this PowerShell session. Run PowerShell as Administrator and verify access to $redirectionConfig. Original error: $($_.Exception.Message)"
}

try {
  [System.IO.File]::OpenRead($applicationHostConfig).Dispose()
} catch {
  throw "IIS applicationHost.config is not readable from this PowerShell session. Run PowerShell as Administrator and verify access to $applicationHostConfig. Original error: $($_.Exception.Message)"
}

function Invoke-AppCmd {
  param(
    [Parameter(Mandatory = $true)]
    [string[]] $Arguments
  )

  $output = & $appcmd @Arguments 2>&1
  if ($LASTEXITCODE -ne 0 -or ($output -match "ERROR \(")) {
    throw ($output -join [Environment]::NewLine)
  }

  $output
}

$siteExistsBeforeDeploy = & $appcmd list site /name:$SiteName 2>$null
if ($LASTEXITCODE -eq 0 -and $siteExistsBeforeDeploy) {
  & $appcmd stop site /site.name:$SiteName 2>$null | Out-Null
}

$appPoolExistsBeforeDeploy = & $appcmd list apppool /name:$SiteName 2>$null
if ($LASTEXITCODE -eq 0 -and $appPoolExistsBeforeDeploy) {
  & $appcmd stop apppool /apppool.name:$SiteName 2>$null | Out-Null
}

New-Item -ItemType Directory -Force -Path $PhysicalPath | Out-Null

$existingDeploymentItems = Get-ChildItem -Path $PhysicalPath -Force -Recurse -ErrorAction SilentlyContinue
foreach ($item in $existingDeploymentItems) {
  if ($item.Attributes -band [System.IO.FileAttributes]::ReadOnly) {
    $item.Attributes = $item.Attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)
  }
}

Copy-Item -Path (Join-Path $SourcePath "web.config") -Destination $PhysicalPath -Force
Copy-Item -Path (Join-Path $SourcePath "package.json") -Destination $PhysicalPath -Force
Copy-Item -Path (Join-Path $SourcePath "pnpm-lock.yaml") -Destination $PhysicalPath -Force
Copy-Item -Path (Join-Path $SourcePath "pnpm-workspace.yaml") -Destination $PhysicalPath -Force

function Set-WebConfigEnvironmentVariable {
  param(
    [Parameter(Mandatory = $true)]
    [xml] $Config,
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [Parameter(Mandatory = $true)]
    [string] $Value
  )

  $webServer = $Config.SelectSingleNode("/configuration/system.webServer")
  if (-not $webServer) {
    $webServer = $Config.CreateElement("system.webServer")
    $Config.configuration.AppendChild($webServer) | Out-Null
  }

  $httpPlatform = $Config.SelectSingleNode("/configuration/system.webServer/httpPlatform")
  if (-not $httpPlatform) {
    $httpPlatform = $Config.CreateElement("httpPlatform")
    $webServer.AppendChild($httpPlatform) | Out-Null
  }

  $environmentVariables = $Config.SelectSingleNode("/configuration/system.webServer/httpPlatform/environmentVariables")
  if (-not $environmentVariables) {
    $environmentVariables = $Config.CreateElement("environmentVariables")
    $httpPlatform.AppendChild($environmentVariables) | Out-Null
  }

  $existing = $environmentVariables.environmentVariable | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  if ($existing) {
    $existing.value = $Value
    return
  }

  $node = $Config.CreateElement("environmentVariable")
  $nameAttribute = $Config.CreateAttribute("name")
  $nameAttribute.Value = $Name
  $valueAttribute = $Config.CreateAttribute("value")
  $valueAttribute.Value = $Value
  $node.Attributes.Append($nameAttribute) | Out-Null
  $node.Attributes.Append($valueAttribute) | Out-Null
  $environmentVariables.AppendChild($node) | Out-Null
}

$deployedWebConfigPath = Join-Path $PhysicalPath "web.config"
[xml] $deployedWebConfig = Get-Content $deployedWebConfigPath
Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "NODE_ENV" -Value "development"
Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "IMAP_PLUGIN_PUBLIC_BASE_URL" -Value $PublicBaseUrl
Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "IMAP_PLUGIN_SETUP_TOKEN" -Value $SetupToken
Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "IMAP_PLUGIN_ACCOUNT_STORE" -Value "sql"
Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "IMAP_PLUGIN_CREDENTIAL_PROVIDER" -Value "dev-sql-vault"
if ($SqlConnectionString) {
  Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "IMAP_PLUGIN_SQL_CONNECTION_STRING" -Value $SqlConnectionString
} elseif ($existingSqlConnectionString) {
  Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "IMAP_PLUGIN_SQL_CONNECTION_STRING" -Value $existingSqlConnectionString
}
if ($ConfigDir) {
  Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "IMAP_PLUGIN_CONFIG_DIR" -Value $ConfigDir
} elseif ($existingConfigDir) {
  Set-WebConfigEnvironmentVariable -Config $deployedWebConfig -Name "IMAP_PLUGIN_CONFIG_DIR" -Value $existingConfigDir
}
$deployedWebConfig.Save($deployedWebConfigPath)

$distExit = robocopy (Join-Path $SourcePath "dist") (Join-Path $PhysicalPath "dist") /MIR /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) {
  throw "Failed to copy dist to $PhysicalPath."
}

Push-Location $PhysicalPath
try {
  if ($pnpm) {
    pnpm install --prod --frozen-lockfile
  } else {
    npm install --omit=dev --no-package-lock
  }
} finally {
  Pop-Location
}

$logsPath = Join-Path $PhysicalPath "logs"
New-Item -ItemType Directory -Force -Path $logsPath | Out-Null

$appPoolIdentity = "IIS AppPool\$SiteName"
icacls $PhysicalPath /grant "${appPoolIdentity}:(OI)(CI)(RX)" | Out-Null
icacls $logsPath /grant "${appPoolIdentity}:(OI)(CI)(M)" | Out-Null

$httpPlatformDll = Join-Path $env:SystemRoot "System32\inetsrv\httpPlatformHandler.dll"
$httpPlatform = & $appcmd list modules /name:httpPlatformHandler 2>$null
if ($LASTEXITCODE -ne 0) {
  if (-not (Test-Path $httpPlatformDll)) {
    throw "IIS HttpPlatformHandler is not installed. Install HttpPlatformHandler, then rerun this script."
  }

  Write-Warning "Could not inspect IIS module registration with appcmd, but httpPlatformHandler.dll exists at $httpPlatformDll. Continuing."
} elseif (-not $httpPlatform) {
  if (Test-Path $httpPlatformDll) {
    Write-Warning "HttpPlatformHandler exists on disk but is not listed as an IIS module. If the site fails to start, restart IIS or repair the HttpPlatformHandler installation."
  } else {
    throw "IIS HttpPlatformHandler is not installed. Install HttpPlatformHandler, then rerun this script."
  }
}

$appPool = & $appcmd list apppool /name:$SiteName 2>$null
if ($LASTEXITCODE -ne 0 -or -not $appPool) {
  Invoke-AppCmd -Arguments @("add", "apppool", "/name:$SiteName") | Out-Null
}

$existing = & $appcmd list site /name:$SiteName 2>$null
if ($LASTEXITCODE -eq 0 -and $existing) {
  Invoke-AppCmd -Arguments @("set", "site", "/site.name:$SiteName", "/bindings:$Binding") | Out-Null
} else {
  Invoke-AppCmd -Arguments @("add", "site", "/name:$SiteName", "/bindings:$Binding", "/physicalPath:$PhysicalPath") | Out-Null
}

Invoke-AppCmd -Arguments @("set", "apppool", "/apppool.name:$SiteName", "/managedRuntimeVersion:") | Out-Null
Invoke-AppCmd -Arguments @("set", "site", "/site.name:$SiteName", "/[path='/'].applicationPool:$SiteName") | Out-Null
Invoke-AppCmd -Arguments @("set", "vdir", "/vdir.name:$SiteName/", "/physicalPath:$PhysicalPath") | Out-Null

$handlersConfig = Invoke-AppCmd -Arguments @("list", "config", $SiteName, "/section:system.webServer/handlers")
if (-not ($handlersConfig -match 'name="httpPlatformHandler"')) {
  Invoke-AppCmd -Arguments @(
    "set",
    "config",
    $SiteName,
    "/section:system.webServer/handlers",
    "/+[name='httpPlatformHandler',path='*',verb='*',modules='httpPlatformHandler',resourceType='Unspecified']",
    "/commit:apphost"
  ) | Out-Null
}

& $appcmd start apppool /apppool.name:$SiteName 2>$null | Out-Null
& $appcmd start site /site.name:$SiteName 2>$null | Out-Null

Write-Host "IIS site is configured."
Write-Host "Physical path: $PhysicalPath"
Write-Host "Health check: $PublicBaseUrl/health"
Write-Host "Setup page:   $PublicBaseUrl/setup"
Write-Host "MCP endpoint: $PublicBaseUrl/mcp"

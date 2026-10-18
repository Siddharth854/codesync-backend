
# ==========================================
# CodeSync Backend - GitHub Deployment
# GitHub: Siddharth854/codesync-backend
# ==========================================

$ErrorActionPreference = "Stop"

$GitHubRepo = "Siddharth854/codesync-backend"
$Branch = "main"
$BackendPath = $PSScriptRoot

# 1. Validate backend folder
Write-Host "`n[1/6] Checking backend files..." -ForegroundColor Cyan

$RequiredFiles = @(
    "package.json",
    "vercel.json",
    "api/index.js"
)

foreach ($File in $RequiredFiles) {
    if (!(Test-Path (Join-Path $BackendPath $File))) {
        throw "Required file missing: $File. Check your backend folder."
    }
}

Set-Location $BackendPath

# 2. Check Git
Write-Host "`n[2/6] Checking Git..." -ForegroundColor Cyan

git --version
if ($LASTEXITCODE -ne 0) {
    throw "Git is not installed or unavailable."
}

# 3. Check for secrets before staging
Write-Host "`n[3/6] Checking environment files..." -ForegroundColor Cyan

if (!(Test-Path ".gitignore")) {
    @"
node_modules/
.env
.env.*
!.env.example
.vercel/
"@ | Set-Content ".gitignore"
}

# Refuse to proceed if a real environment file is tracked
$TrackedEnv = git ls-files --cached -- ".env" ".env.local" ".env.production"

if ($TrackedEnv) {
    Write-Host "Warning: environment files are already tracked by Git." -ForegroundColor Yellow
    Write-Host "Remove them from tracking and check that no secrets were committed."
    throw "Stopped to protect your secrets."
}

# 4. Initialize Git and stage files
Write-Host "`n[4/6] Preparing Git commit..." -ForegroundColor Cyan

if (!(Test-Path ".git")) {
    git init
    if ($LASTEXITCODE -ne 0) {
        throw "git init failed."
    }
}

git branch -M $Branch
if ($LASTEXITCODE -ne 0) {
    throw "Could not set branch to $Branch."
}

git add .
if ($LASTEXITCODE -ne 0) {
    throw "git add failed."
}

# Check for accidentally staged environment files
$StagedEnv = git diff --cached --name-only |
    Where-Object { $_ -match '(^|/)\.env($|\.)' -and $_ -ne ".env.example" }

if ($StagedEnv) {
    git restore --staged -- $StagedEnv
    throw "Environment file staged. It was unstaged; review .gitignore before continuing."
}

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    $CommitMessage = Read-Host "Commit message (Enter for Deploy CodeSync backend)"

    if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
        $CommitMessage = "Deploy CodeSync backend"
    }

    git commit -m $CommitMessage
    if ($LASTEXITCODE -ne 0) {
        throw "Git commit failed."
    }
} else {
    Write-Host "No new changes to commit." -ForegroundColor Yellow
}

# 5. Configure remote
Write-Host "`n[5/6] Configuring GitHub remote..." -ForegroundColor Cyan

$RemoteUrl = "https://github.com/$GitHubRepo.git"
$ExistingRemote = git remote get-url origin 2>$null

if ($LASTEXITCODE -eq 0) {
    git remote set-url origin $RemoteUrl
} else {
    git remote add origin $RemoteUrl
}

if ($LASTEXITCODE -ne 0) {
    throw "Could not configure GitHub remote."
}

# 6. Push to GitHub
Write-Host "`n[6/6] Pushing to GitHub..." -ForegroundColor Cyan

git push -u origin $Branch

if ($LASTEXITCODE -ne 0) {
    throw "Push failed. Check GitHub authentication and whether the remote repository already has commits."
}

Write-Host "`nSUCCESS! Backend pushed to GitHub." -ForegroundColor Green
Write-Host "Repository: https://github.com/$GitHubRepo"
Write-Host "`nNext: Import this repository into Vercel." -ForegroundColor Cyan

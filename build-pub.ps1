$ErrorActionPreference = 'Stop'
# 把 pub.js + pub.html 合成单文件，用 Node SEA 打成「Burger Chat 发布端.exe」

$SRC   = 'D:\app1\发布端'
$WORK  = 'D:\PubBuild'
$NODE  = (Get-Command node).Source
$OUT   = 'D:\app1\发布'
$TOOLS = 'D:\ExeBuild\npm'

Write-Host '--- 0. 准备工作目录 ---'
if (Test-Path $WORK) { Remove-Item $WORK -Recurse -Force }
New-Item -ItemType Directory -Force -Path $WORK, $TOOLS | Out-Null
Copy-Item -LiteralPath 'D:\app1\电脑端\tools\rcedit-run.js' -Destination "$TOOLS\rcedit-pub.js" -Force
if (-not (Test-Path "$TOOLS\node_modules\rcedit")) {
    Push-Location $TOOLS; npm i rcedit --no-audit --no-fund 2>&1 | Out-String | Out-Host; Pop-Location
}
if (-not (Test-Path "$TOOLS\node_modules\rcedit")) { throw 'rcedit 依赖安装失败' }

function JsStr([string]$path) {
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $json = ConvertTo-Json -InputObject $text -Compress
    $json = $json -replace ([string][char]0x2028), '\u2028'
    $json = $json -replace ([string][char]0x2029), '\u2029'
    return $json
}

Write-Host '--- 1. 合并成 pub-app.js ---'
$head = "'use strict';"
$head += "`nglobal.__PUB_HTML__ = $(JsStr "$SRC\pub.html");"
$body = [System.IO.File]::ReadAllText("$SRC\pub.js", [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText("$WORK\pub-app.js", $head + "`n" + $body, (New-Object System.Text.UTF8Encoding($false)))

Write-Host '--- 2. 语法自检 ---'
& $NODE --check "$WORK\pub-app.js"
if ($LASTEXITCODE -ne 0) { throw '合并后的脚本语法有误' }

Write-Host '--- 3. 生成 SEA blob ---'
$cfg = [ordered]@{
    main = "$WORK\pub-app.js"
    output = "$WORK\sea-prep.blob"
    disableExperimentalSEAWarning = $true
    useCodeCache = $false
}
[System.IO.File]::WriteAllText("$WORK\sea-config.json", (ConvertTo-Json -InputObject $cfg -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
& $NODE --experimental-sea-config "$WORK\sea-config.json"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$WORK\sea-prep.blob")) { throw 'SEA blob 生成失败' }

Write-Host '--- 4. 复制 node.exe 并设置图标 ---'
Copy-Item -LiteralPath $NODE -Destination "$WORK\pub.exe" -Force
& $NODE "$TOOLS\rcedit-pub.js" "$WORK\pub.exe" "D:\app1\电脑端\app.ico"
if ($LASTEXITCODE -ne 0) { throw '设置图标失败' }

Write-Host '--- 5. 注入 blob ---'
& npx --yes postject "$WORK\pub.exe" NODE_SEA_BLOB "$WORK\sea-prep.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw 'postject 注入失败' }

Write-Host '--- 6. 改成 GUI 子系统 ---'
$fs = [System.IO.File]::Open("$WORK\pub.exe", 'Open', 'ReadWrite')
$br = New-Object System.IO.BinaryReader($fs)
$fs.Position = 0x3C; $lfanew = $br.ReadInt32()
$fs.Position = $lfanew + 24 + 68
$br.ReadUInt16() | Out-Null
$bw = New-Object System.IO.BinaryWriter($fs)
$fs.Position = $lfanew + 24 + 68
$bw.Write([UInt16]2)
$bw.Dispose(); $br.Dispose(); $fs.Dispose()

Write-Host '--- 7. 冒烟测试（临时端口 18970） ---'
$testDir = "$WORK\smoke"; New-Item -ItemType Directory -Force -Path $testDir | Out-Null
$proc = Start-Process -FilePath "$WORK\pub.exe" -ArgumentList '18970' -WorkingDirectory $testDir -PassThru
Start-Sleep -Seconds 5
$ok = $false
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18970/api/latest' -TimeoutSec 8 -UseBasicParsing
    $ok = ($r.StatusCode -eq 200) -and ($r.Content -like '*burger-pub*')
    Write-Host ("latest => " + $r.StatusCode + " " + $r.Content)
} catch { Write-Host ("请求失败: " + $_.Exception.Message) }
$pageOk = $false
try {
    $p = Invoke-WebRequest -Uri 'http://127.0.0.1:18970/' -TimeoutSec 8 -UseBasicParsing
    $pageOk = ($p.Content -like '*Burger Chat 发布端*') -and ($p.StatusCode -eq 200)
    Write-Host ("page => " + $p.StatusCode + " len=" + $p.Content.Length)
} catch { Write-Host ("页面失败: " + $_.Exception.Message) }
try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
if (-not ($ok -and $pageOk)) { throw '发布端冒烟测试未通过' }

Write-Host '--- 8. 输出 ---'
New-Item -ItemType Directory -Force -Path "$OUT\Burger Chat-发布端" | Out-Null
Copy-Item -LiteralPath "$WORK\pub.exe" -Destination "$OUT\Burger Chat-发布端\Burger Chat 发布端.exe" -Force
$fi = Get-Item "$OUT\Burger Chat-发布端\Burger Chat 发布端.exe"
"文件: " + $fi.FullName
"大小: " + [math]::Round($fi.Length / 1MB, 1) + " MB"

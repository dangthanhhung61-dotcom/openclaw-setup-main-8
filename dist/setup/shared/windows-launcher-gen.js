'use strict';

/**
 * Double-click launchers for a NATIVE bot on Windows.
 *
 * Why these exist instead of a Scheduled Task: `openclaw daemon install` creates a task with
 * `LogonType: Interactive`, which means the gateway is tied to whoever's login session started
 * it. Two consequences measured on win_kha (10/09/2026):
 *   • anything started over SSH dies the moment the session closes (LastTaskResult 0xC000013A);
 *   • a task set to run at boot is refused outright, because "at startup" and "only while
 *     someone is logged in" contradict each other (0x800710E0).
 * Making it run without a login needs the account password stored in the task - Task Scheduler
 * rejected that too ("The user account is unknown, the password is incorrect"). So the owner
 * drives it by hand, exactly like the .command files on macOS.
 *
 * Every trap below cost a round trip with a customer waiting, so they are encoded here:
 *
 *  1. `.cmd` MUST be CRLF. LF-only files break on Windows.
 *  2. Never name a launcher after the command it calls. `9router.cmd` in the project dir plus
 *     `cd /d <project>` makes `call 9router` re-enter the same file - BATCH RECURSION, and the
 *     process dies before doing anything.
 *  3. Never append to a fixed log file. 9router holds its log open for its whole lifetime, so
 *     the SECOND run cannot open it and exits with "The process cannot access the file because
 *     it is being used by another process" - invisible on the first run, which is why it is easy
 *     to ship broken.
 *  4. 9router shows a `Choose Interface` menu when its stdout looks like a real console. Started
 *     hidden, nobody can answer it, so it hangs and never opens its port. `> NUL` is what tells
 *     it to run unattended. Symptom without it: works when run by hand, silently dead in the
 *     background - same command.
 *  5. `Start-Process -WindowStyle Hidden` does NOT hide a console a .cmd opens for itself. Only
 *     WScript.Shell.Run(..., 0, False) truly hides it. Leaving a visible window is not cosmetic:
 *     it IS the bot, and closing it kills the bot.
 *  6. Anchor the working directory. Agents may carry relative workspace paths, which resolve
 *     against the launcher's cwd - move the files into a folder and those bots die with
 *     WORKSPACE_VANISHED while the others keep working.
 */

const CRLF = (s) => s.replace(/\r?\n/g, '\r\n');

/** Hidden-launch helper. WScript is the only reliable way to start a .cmd with no window. */
function buildRunHiddenVbs() {
  return CRLF(
    'Set sh = CreateObject("WScript.Shell")\n' +
    'sh.Run "cmd /c """ & WScript.Arguments(0) & """", 0, False\n',
  );
}

/** Starts 9router. Named start-9router.cmd on purpose - see trap 2. */
function build9RouterCmd({ projectDir, routerPort }) {
  return CRLF(
    '@echo off\n' +
    'rem Ten tep KHONG duoc la "9router.cmd": trung ten thi lenh ben duoi goi lai chinh no.\n' +
    'rem "> NUL" la bat buoc: neu dau ra la man hinh that, 9router bay menu "Choose Interface"\n' +
    'rem roi cho nguoi chon va khong bao gio mo cong.\n' +
    `cd /d ${projectDir}\n` +
    `set "DATA_DIR=${projectDir}\\.9router"\n` +
    `call 9router -n -l -H 127.0.0.1 -p ${routerPort} --skip-update > NUL 2>&1\n`,
  );
}

/**
 * The node host that gives the bot screen control.
 *
 * Two things here are not obvious and both cost a day:
 *  - It runs against `<project>\.openclaw-node`, NOT the bot's state dir. Pointed at the bot's, it
 *    loads the bot's plugins too, and zalo-mod's dashboard port is already held by the gateway, so
 *    the node dies on `listen EADDRINUSE 127.0.0.1:18790` before publishing computer.act.
 *  - It is launched as a .cmd through wscript like everything else on Windows. Spawning the
 *    `openclaw.cmd` shim from Node with detached+shell fails outright with `spawn EINVAL`.
 */
function buildNodeHostCmd({ projectDir, gatewayPort, gatewayToken }) {
  return CRLF(
    '@echo off\n' +
    'rem Node host cho tinh nang dieu khien may (tool computer/screen cua OpenClaw).\n' +
    `cd /d ${projectDir}\n` +
    'set "HOME=%USERPROFILE%"\n' +
    `set "OPENCLAW_HOME=${projectDir}\\.openclaw-node"\n` +
    `set "OPENCLAW_STATE_DIR=${projectDir}\\.openclaw-node"\n` +
    (gatewayToken ? `set "OPENCLAW_GATEWAY_TOKEN=${gatewayToken}"\n` : '') +
    '"%ProgramFiles%\\nodejs\\node.exe" ' +
    '"%APPDATA%\\npm\\node_modules\\openclaw\\dist\\index.js" ' +
    `node run --host 127.0.0.1 --port ${gatewayPort} --no-tls\n`,
  );
}

/** Starts the gateway. Calls node directly - see the --task-supervisor note below. */
function buildGatewayCmd({ projectDir, gatewayPort, stateDir }) {
  return CRLF(
    '@echo off\n' +
    'rem Goi thang node, KHONG qua gateway.cmd cua openclaw: tep do chay kem --task-supervisor,\n' +
    'rem no di tim Scheduled Task de ban giao; khong co task thi no de them tien trinh + cua so.\n' +
    'rem Khong redirect ra tep co dinh (xem trap 3) - openclaw tu ghi nhat ky trong %TEMP%\\openclaw.\n' +
    `cd /d ${projectDir}\n` +
    'set "HOME=%USERPROFILE%"\n' +
    // Name the state dir outright. Setting only HOME works when the state was moved to
    // %USERPROFILE%\.openclaw (the >=2026.8 layout prepareNativeStateHome sets up), and silently
    // does not when it was left in the project: the gateway then finds no config and exits with
    // "Missing config. Run `openclaw setup`", which reads like a broken install rather than a
    // launcher looking in the wrong place. Measured on win_phuc, 12/09/2026, after a migration
    // that stopped before the state move. This value is the resolved path, so it is right under
    // both layouts (the project copy may be a junction, and 2026.8 fs-safe refuses those).
    `set "OPENCLAW_HOME=${stateDir}"\n` +
    `set "OPENCLAW_STATE_DIR=${stateDir}"\n` +
    `set "OPENCLAW_GATEWAY_PORT=${gatewayPort}"\n` +
    `set "OPENCLAW_PORT=${gatewayPort}"\n` +
    '"%ProgramFiles%\\nodejs\\node.exe" --max-old-space-size=8192 ' +
    `"%APPDATA%\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port ${gatewayPort}\n`,
  );
}

function buildSetupUiCmd({ projectDir, setupPort }) {
  return CRLF(
    '@echo off\n' +
    'rem Ten tep nhat ky kem gio, de lan chay sau khong dung vao tep dang bi giu (trap 3).\n' +
    `cd /d ${projectDir}\n` +
    'for /f "tokens=1-4 delims=/: " %%a in ("%TIME%") do set "T=%%a%%b%%c"\n' +
    // `--yes` is not optional. Whenever the installed version differs from what npx resolves - which
    // is EVERY time a new version is published - npx stops at "Need to install the following
    // packages ... Ok to proceed? (y)". The launcher runs hidden, so nobody can answer it: the
    // window sits there forever and the dashboard simply never opens. Measured on a customer
    // machine, where it looked like the tunnel was broken rather than a prompt waiting offscreen.
    `call npx --yes create-openclaw-bot --host=127.0.0.1 --port=${setupPort} --no-open --project-dir=${projectDir}` +
    ` > "${projectDir}\\setup-ui-%T%.log" 2>&1\n`,
  );
}

function buildStartBotCmd({ projectDir, gatewayPort, routerPort }) {
  const dashPort = gatewayPort + 1;
  return CRLF(
    '@echo off\n' +
    'title Khoi dong bot OpenClaw\n' +
    'color 0A\n' +
    `cd /d ${projectDir}\n` +
    'echo.\n' +
    'echo   ============================================\n' +
    `echo      KHOI DONG BOT  --  ${projectDir}\n` +
    'echo   ============================================\n' +
    'echo.\n' +
    'echo   Dang bat 9Router...\n' +
    `powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort ${routerPort} -State Listen -EA SilentlyContinue)) { Start-Process wscript -ArgumentList '${projectDir}\\run-hidden.vbs','${projectDir}\\start-9router.cmd' -WindowStyle Hidden }" >nul 2>&1\n` +
    'echo   Cho 9Router san sang...\n' +
    `powershell -NoProfile -Command "for($i=0;$i -lt 20;$i++){ try{ Invoke-WebRequest 'http://127.0.0.1:${routerPort}/' -UseBasicParsing -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep -Seconds 2 } }"\n` +
    'echo   Dang bat bot (gateway)...\n' +
    `powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort ${gatewayPort} -State Listen -EA SilentlyContinue)) { Start-Process wscript -ArgumentList '${projectDir}\\run-hidden.vbs','${projectDir}\\gateway-start.cmd' -WindowStyle Hidden }" >nul 2>&1\n` +
    'echo   Cho bot san sang (co the mat 30-60 giay)...\n' +
    'echo.\n' +
    `powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ try{ Invoke-WebRequest 'http://127.0.0.1:${gatewayPort}/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; $ok=$true; break } catch { Start-Sleep -Seconds 3 } }; if($ok){ Write-Host '   [OK] Bot da chay.' -ForegroundColor Green } else { Write-Host '   [LOI] Bot chua len.' -ForegroundColor Red }"\n` +
    // Bring screen control back up too. The node host dies with the login session like everything
    // else, and nothing else restarts it: PC control would quietly stop working after every logout
    // or reboot, with the dashboard still showing it as ON. Only start it when .openclaw-node
    // exists - that directory is written when the operator turns PC control on, so a project that
    // never enabled it starts nothing extra.
    `if exist "${projectDir}\\.openclaw-node\\openclaw.json" (\n` +
    '  echo   Dang bat dieu khien may...\n' +
    `  powershell -NoProfile -Command "if (-not (Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*node*run*--host*' })) { Start-Process wscript -ArgumentList '${projectDir}\\run-hidden.vbs','${projectDir}\\node-host.cmd' -WindowStyle Hidden }" >nul 2>&1\n` +
    ')\n' +
    'echo.\n' +
    'echo   --- Trang thai ---\n' +
    `powershell -NoProfile -Command "foreach($x in @(@('Bot (gateway)','http://127.0.0.1:${gatewayPort}/health'),@('9Router','http://127.0.0.1:${routerPort}/'),@('Bang dieu khien Zalo','http://127.0.0.1:${dashPort}/dashboard'))){ try{ (Invoke-WebRequest $x[1] -UseBasicParsing -TimeoutSec 6) | Out-Null; Write-Host ('   {0,-22} DANG CHAY' -f $x[0]) -ForegroundColor Green } catch { Write-Host ('   {0,-22} TAT' -f $x[0]) -ForegroundColor Red } }"\n` +
    'echo.\n' +
    'echo   Bot chay AN, khong co cua so nao de lo tay dong.\n' +
    'echo   Bot chi tat khi ban DANG XUAT / TAT may, hoac bam "3 - DUNG BOT".\n' +
    'echo.\n' +
    'timeout /t 12 >nul\n',
  );
}

function buildOpenUiCmd({ projectDir, setupPort }) {
  return CRLF(
    '@echo off\n' +
    'title Mo giao dien bot\n' +
    'color 0B\n' +
    `cd /d ${projectDir}\n` +
    'echo.\n' +
    'echo   ============================================\n' +
    'echo      MO GIAO DIEN QUAN TRI BOT\n' +
    'echo   ============================================\n' +
    'echo.\n' +
    `powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort ${setupPort} -State Listen -EA SilentlyContinue)) { Write-Host '   Dang bat giao dien...'; Start-Process wscript -ArgumentList '${projectDir}\\run-hidden.vbs','${projectDir}\\setup-ui.cmd' -WindowStyle Hidden } else { Write-Host '   Giao dien dang chay san.' }"\n` +
    'echo   Cho giao dien san sang...\n' +
    `powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ try{ Invoke-WebRequest 'http://127.0.0.1:${setupPort}/' -UseBasicParsing -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep -Seconds 2 } }"\n` +
    `start "" http://127.0.0.1:${setupPort}\n` +
    'echo.\n' +
    'echo   Da mo trinh duyet. Dong cua so nay duoc roi.\n' +
    'timeout /t 8 >nul\n',
  );
}

function buildStopBotCmd({ gatewayPort, routerPort }) {
  return CRLF(
    '@echo off\n' +
    'title Dung bot OpenClaw\n' +
    'color 0C\n' +
    'echo.\n' +
    'echo   Dang dung bot va 9Router...\n' +
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*openclaw*gateway*\' -or $_.CommandLine -like \'*9router*\' } | ForEach-Object { Write-Host (\'   dung PID \' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }"\n' +
    'echo.\n' +
    `powershell -NoProfile -Command "Start-Sleep -Seconds 3; foreach($x in @(@('Bot',${gatewayPort}),@('9Router',${routerPort}))){ $c=Get-NetTCPConnection -LocalPort $x[1] -State Listen -EA SilentlyContinue; if($c){ Write-Host ('   {0,-10} VAN CHAY' -f $x[0]) -ForegroundColor Yellow } else { Write-Host ('   {0,-10} da tat' -f $x[0]) -ForegroundColor Green } }"\n` +
    'echo.\n' +
    'pause\n',
  );
}

function buildReadme({ projectDir, gatewayPort, routerPort, setupPort }) {
  return CRLF(
    'BOT OPENCLAW TREN MAY NAY - HUONG DAN NHANH\n' +
    '===========================================\n\n' +
    'Tren Desktop co bieu tuong "Bot OpenClaw". Bam dup de mo bang dieu khien:\n' +
    'bang hien bot dang chay hay tat, va co san cac nut ben duoi.\n\n' +
    '  Khoi dong bot             Bat bot len. Bam sau moi lan khoi dong may.\n' +
    '  Mo giao dien quan tri     Mo trang quan tri bot trong trinh duyet.\n' +
    '  Dung bot                  Tat bot (chi dung khi can).\n\n' +
    'Cac nut nay chay ba tep .cmd trong ' + projectDir + ' - bam dup truc tiep cung duoc:\n' +
    '  1 - KHOI DONG BOT.cmd, 2 - MO GIAO DIEN.cmd, 3 - DUNG BOT.cmd\n\n' +
    'QUAN TRONG\n' +
    '----------\n' +
    '- Bot chay AN hoan toan: khong co cua so den nao nam tren man hinh.\n' +
    '- Bot KHONG tu chay khi bat may. Sau moi lan khoi dong lai may,\n' +
    '  bam "1 - KHOI DONG BOT" mot lan la xong.\n' +
    '- Bot se tat khi ban DANG XUAT hoac TAT may.\n' +
    '- Mat bieu tuong tren Desktop? Bam dup bot-panel.vbs trong ' + projectDir + ',\n' +
    '  hoac mo lai giao dien quan tri, bieu tuong se duoc tao lai.\n\n' +
    'Cong dang dung:\n' +
    `  ${gatewayPort}  bot (gateway)\n` +
    `  ${gatewayPort + 1}  bang dieu khien Zalo\n` +
    `  ${routerPort}  9Router\n` +
    `  ${setupPort}  giao dien quan tri\n`,
  );
}

/**
 * The one Desktop icon: a small window with live status and the three launcher buttons.
 *
 * Four loose files on the Desktop (readme + three .cmd) looked like stray scripts and had the generic
 * gear icon, so owners could not tell which one was the bot. The panel only RUNS those same .cmd
 * files from the project folder - start/stop logic stays in one place and the traps above still
 * apply. Status comes from the listening ports (GetActiveTcpListeners: no CIM, so it does not stall
 * the window), refreshed every 3s.
 *
 * Written with a UTF-8 BOM: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI and the Vietnamese
 * labels turn into mojibake. No PowerShell backticks anywhere - this is a JS template.
 */
function buildBotPanelPs1({ gatewayPort, routerPort, setupPort }) {
  const lines = [
    '# Bang dieu khien bot OpenClaw - do openclaw-setup tao, moi lan cai/cap nhat se ghi de.',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$dir = $PSScriptRoot',
    '$created = $false',
    `$mutex = New-Object System.Threading.Mutex($true, 'OpenClawBotPanel-${gatewayPort}', [ref]$created)`,
    // Second double-click: bring the open panel forward instead of stacking another one.
    "if (-not $created) { (New-Object -ComObject WScript.Shell).AppActivate('Bot OpenClaw') | Out-Null; exit }",
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '',
    '$services = @(',
    `  @{ Name = 'Bot (gateway)'; Port = ${gatewayPort} },`,
    `  @{ Name = 'Bảng điều khiển Zalo'; Port = ${gatewayPort + 1} },`,
    `  @{ Name = '9Router'; Port = ${routerPort} },`,
    `  @{ Name = 'Giao diện quản trị'; Port = ${setupPort} }`,
    ')',
    '',
    '$form = New-Object System.Windows.Forms.Form',
    "$form.Text = 'Bot OpenClaw'",
    "$form.StartPosition = 'CenterScreen'",
    "$form.FormBorderStyle = 'FixedSingle'",
    '$form.MaximizeBox = $false',
    '$form.ClientSize = New-Object System.Drawing.Size(340, 386)',
    "$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)",
    '$form.BackColor = [System.Drawing.Color]::White',
    "$icoPath = Join-Path $dir 'bot.ico'",
    'if (Test-Path $icoPath) { $form.Icon = New-Object System.Drawing.Icon($icoPath) }',
    '',
    '$title = New-Object System.Windows.Forms.Label',
    "$title.Text = 'Bot OpenClaw'",
    "$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 15)",
    '$title.AutoSize = $true',
    '$title.Location = New-Object System.Drawing.Point(18, 12)',
    '$form.Controls.Add($title)',
    '$where = New-Object System.Windows.Forms.Label',
    '$where.Text = $dir',
    '$where.ForeColor = [System.Drawing.Color]::Gray',
    '$where.AutoEllipsis = $true',
    '$where.Size = New-Object System.Drawing.Size(300, 22)',
    '$where.Location = New-Object System.Drawing.Point(21, 44)',
    '$form.Controls.Add($where)',
    '',
    '$rows = @()',
    '$y = 78',
    'foreach ($s in $services) {',
    '  $dot = New-Object System.Windows.Forms.Panel',
    '  $dot.Size = New-Object System.Drawing.Size(12, 12)',
    '  $dot.Location = New-Object System.Drawing.Point(24, ($y + 5))',
    '  $dot.BackColor = [System.Drawing.Color]::Silver',
    '  $name = New-Object System.Windows.Forms.Label',
    '  $name.Text = $s.Name',
    '  $name.AutoSize = $true',
    '  $name.Location = New-Object System.Drawing.Point(44, $y)',
    '  $stateLabel = New-Object System.Windows.Forms.Label',
    "  $stateLabel.Text = '...'",
    "  $stateLabel.TextAlign = 'MiddleRight'",
    '  $stateLabel.Size = New-Object System.Drawing.Size(110, 22)',
    '  $stateLabel.Location = New-Object System.Drawing.Point(208, ($y - 1))',
    '  $form.Controls.AddRange(@($dot, $name, $stateLabel))',
    '  $rows += @{ Port = $s.Port; Dot = $dot; State = $stateLabel }',
    '  $y += 28',
    '}',
    '',
    'function Update-Status {',
    '  $open = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })',
    '  foreach ($r in $rows) {',
    '    if ($open -contains $r.Port) {',
    '      $r.Dot.BackColor = [System.Drawing.Color]::FromArgb(34, 160, 80)',
    "      $r.State.Text = 'Đang chạy'",
    '      $r.State.ForeColor = [System.Drawing.Color]::FromArgb(34, 130, 70)',
    '    } else {',
    '      $r.Dot.BackColor = [System.Drawing.Color]::FromArgb(200, 60, 60)',
    "      $r.State.Text = 'Tắt'",
    '      $r.State.ForeColor = [System.Drawing.Color]::FromArgb(170, 50, 50)',
    '    }',
    '  }',
    '}',
    '',
    // Same as double-clicking the file: its own console shows progress, cwd is the project.
    'function Start-Launcher($file) {',
    '  $path = Join-Path $dir $file',
    '  if (Test-Path $path) { Start-Process -FilePath $path -WorkingDirectory $dir }',
    "  else { [System.Windows.Forms.MessageBox]::Show(('Không tìm thấy ' + $file + ' trong ' + $dir), 'Bot OpenClaw') | Out-Null }",
    '}',
    '',
    '$buttons = @(',
    "  @{ Text = 'Khởi động bot'; Bold = $true; Click = { Start-Launcher '1 - KHOI DONG BOT.cmd' } },",
    "  @{ Text = 'Mở giao diện quản trị'; Bold = $false; Click = { Start-Launcher '2 - MO GIAO DIEN.cmd' } },",
    "  @{ Text = 'Dừng bot'; Bold = $false; Click = {",
    "      $ans = [System.Windows.Forms.MessageBox]::Show('Dừng bot? Bot sẽ không trả lời tin nhắn cho tới khi bấm Khởi động bot.', 'Bot OpenClaw', 'YesNo', 'Question')",
    "      if ($ans -eq 'Yes') { Start-Launcher '3 - DUNG BOT.cmd' } } },",
    "  @{ Text = 'Hướng dẫn'; Bold = $false; Click = { Start-Process notepad.exe -ArgumentList ('\"' + (Join-Path $dir '0 - DOC TRUOC.txt') + '\"') } }",
    ')',
    '$y += 14',
    'foreach ($b in $buttons) {',
    '  $btn = New-Object System.Windows.Forms.Button',
    '  $btn.Text = $b.Text',
    "  if ($b.Bold) { $btn.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10) }",
    '  $btn.Size = New-Object System.Drawing.Size(300, 38)',
    '  $btn.Location = New-Object System.Drawing.Point(20, $y)',
    '  $btn.Add_Click($b.Click)',
    '  $form.Controls.Add($btn)',
    '  $y += 46',
    '}',
    '',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 3000',
    '$timer.Add_Tick({ Update-Status })',
    '$form.Add_Shown({ Update-Status; $timer.Start() })',
    '$form.Add_FormClosed({ $timer.Stop(); $mutex.ReleaseMutex() })',
    '[System.Windows.Forms.Application]::Run($form)',
  ];
  return '﻿' + CRLF(lines.join('\n') + '\n');
}

/** What the Desktop icon runs: PowerShell with no console flash (trap 5), wherever the project is. */
function buildBotPanelVbs() {
  return CRLF(
    'Set fso = CreateObject("Scripting.FileSystemObject")\n' +
    'd = fso.GetParentFolderName(WScript.ScriptFullName)\n' +
    'CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & d & "\\bot-panel.ps1""", 0, False\n',
  );
}

/** All launcher files for a native Windows project, as { relativeName: content }. */
function buildWindowsLaunchers({ projectDir, gatewayPort = 18789, routerPort = 20128, setupPort = 51789, gatewayToken = '', stateDir = '' }) {
  const opts = { projectDir, gatewayPort, routerPort, setupPort, gatewayToken, stateDir: stateDir || `${projectDir}\\.openclaw` };
  return {
    'bot-panel.ps1': buildBotPanelPs1(opts),
    'bot-panel.vbs': buildBotPanelVbs(),
    'run-hidden.vbs': buildRunHiddenVbs(),
    'start-9router.cmd': build9RouterCmd(opts),
    'gateway-start.cmd': buildGatewayCmd(opts),
    'node-host.cmd': buildNodeHostCmd(opts),
    'setup-ui.cmd': buildSetupUiCmd(opts),
    '0 - DOC TRUOC.txt': buildReadme(opts),
    '1 - KHOI DONG BOT.cmd': buildStartBotCmd(opts),
    '2 - MO GIAO DIEN.cmd': buildOpenUiCmd(opts),
    '3 - DUNG BOT.cmd': buildStopBotCmd(opts),
  };
}

/** The single Desktop shortcut (ASCII name: WScript.Shell CreateShortcut fails on Unicode names in PS 5.1). */
const WINDOWS_PANEL_SHORTCUT = 'Bot OpenClaw.lnk';

/** Loose copies older builds put on the Desktop; the panel replaces them, so they are removed. */
const WINDOWS_DESKTOP_LAUNCHERS = ['0 - DOC TRUOC.txt', '1 - KHOI DONG BOT.cmd', '2 - MO GIAO DIEN.cmd', '3 - DUNG BOT.cmd'];

const api = { buildWindowsLaunchers, WINDOWS_DESKTOP_LAUNCHERS, WINDOWS_PANEL_SHORTCUT };
if (typeof globalThis !== 'undefined') globalThis.__openclawWindowsLaunchers = api;
if (typeof exports !== 'undefined') Object.assign(exports, api);

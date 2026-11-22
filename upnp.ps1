param([string]$Action = "map", [int]$Ext = 54970, [int]$Int = 54970, [string]$Ip = "192.168.31.58")
$ErrorActionPreference = "Stop"
$SSDP_ADDR = "239.255.255.250"
$SSDP_PORT = 1900
function Discover {
  $udp = New-Object System.Net.Sockets.UdpClient
  $udp.Client.ReceiveTimeout = 3000
  $udp.Client.Bind((New-Object System.Net.IPEndPoint([Net.IPAddress]::Any, 0)))
  $msg = "M-SEARCH * HTTP/1.1`r`nHOST: 239.255.255.250:1900`r`nMAN: `"ssdp:discover`"`r`nMX: 2`r`nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1`r`n`r`n"
  $bytes = [Text.Encoding]::ASCII.GetBytes($msg)
  $ep = New-Object System.Net.IPEndPoint([Net.IPAddress]::Parse($SSDP_ADDR), $SSDP_PORT)
  $udp.Send($bytes, $bytes.Length, $ep) | Out-Null
  $found = @()
  $deadline = (Get-Date).AddSeconds(4)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = $udp.Receive([ref]$null)
      $txt = [Text.Encoding]::ASCII.GetString($r)
      if ($txt -match "LOCATION: *(.+)") { $found += $Matches[1].Trim() }
    } catch { break }
  }
  $udp.Close()
  return $found | Select-Object -Unique
}
$locs = Discover
if (-not $locs) { "SSDP: 没找到网关"; exit 1 }
"网关描述: $($locs -join ', ')"
$loc = $locs[0]
[xml]$d = (Invoke-WebRequest -Uri $loc -TimeoutSec 8 -UseBasicParsing).Content
$svc = $d.SelectNodes("//*[local-name()='serviceType' and text()='urn:schemas-upnp-org:service:WANPPPConnection:1'] | //*[local-name()='serviceType' and text()='urn:schemas-upnp-org:service:WANIPConnection:1']")
if (-not $svc) { "没有 WAN 连接服务（可能是桥接/中继模式）"; exit 1 }
# 找 controlURL
$node = $svc[0].ParentNode.ParentNode
$ctl = $node.SelectSingleNode("*[local-name()='controlURL']").InnerText
$base = [Uri]$loc
$ctlUrl = (New-Object Uri($base, $ctl)).AbsoluteUri
"控制地址: $ctlUrl"
if ($Action -eq "list") {
  $body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/></s:Body></s:Envelope>'
  $resp = Invoke-WebRequest -Uri $ctlUrl -Method Post -Headers @{ SOAPAction = '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"'; "Content-Type" = 'text/xml; charset="utf-8"' } -Body $body -TimeoutSec 10 -UseBasicParsing
  "外网地址: " + ([regex]::Match($resp.Content, "<NewExternalIPAddress>([^<]+)<").Groups[1].Value)
  exit 0
}
$body = "<?xml version=`"1.0`"?><s:Envelope xmlns:s=`"http://schemas.xmlsoap.org/soap/envelope/`" s:encodingStyle=`"http://schemas.xmlsoap.org/soap/encoding/`"><s:Body><u:AddPortMapping xmlns:u=`"urn:schemas-upnp-org:service:WANIPConnection:1`"><NewRemoteHost></NewRemoteHost><NewExternalPort>$Ext</NewExternalPort><NewProtocol>TCP</NewProtocol><NewInternalPort>$Int</NewInternalPort><NewInternalClient>$Ip</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>BurgerChat-Pub</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration></u:AddPortMapping></s:Body></s:Envelope>"
try {
  $resp = Invoke-WebRequest -Uri $ctlUrl -Method Post -Headers @{ SOAPAction = '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"'; "Content-Type" = 'text/xml; charset="utf-8"' } -Body $body -TimeoutSec 15 -UseBasicParsing
  "映射结果: $($resp.StatusCode)"; if ($resp.Content -match "errorCode") { $resp.Content }
} catch {
  "映射失败: $($_.Exception.Message)"
}

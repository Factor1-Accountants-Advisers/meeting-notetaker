/**
 * electron-builder msiProjectCreated hook.
 *
 * Called after the WiX project.wxs is generated but before compilation.
 * Injects two WiX customisations:
 *   1. CloseApplication — sends WM_CLOSE to the running app before
 *      install/upgrade/uninstall so the process actually shuts down.
 *   2. RemoveFolderEx — deletes %LOCALAPPDATA%\meeting-notetaker-desktop
 *      on uninstall, removing the MSAL token cache and any other user data.
 *
 * Requires WixUtilExtension (added via additionalWixArgs in electron-builder.yml).
 */

const fs = require('fs');

module.exports = async function msiProjectCreated(projectFile) {
  let xml = fs.readFileSync(projectFile, 'utf-8');

  // --- 1. Add WixUtilExtension namespace ---
  // WiX 4 uses wixtoolset.org namespace, not schemas.microsoft.com
  if (!xml.includes('xmlns:util=')) {
    xml = xml.replace(
      '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"',
      '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"\n     xmlns:util="http://wixtoolset.org/schemas/v4/wxs/util"',
    );
  }

  // --- 2. Inject CloseApplication into the Product element ---
  // This tells the MSI to gracefully close the running Electron process
  // before proceeding with install, upgrade, or uninstall.
  const closeAppXml = `
    <!-- Close running app before install/upgrade/uninstall -->
    <util:CloseApplication
      Id="CloseMeetingNoteTaker"
      Target="Meeting Note-Taker.exe"
      CloseMessage="yes"
      RebootPrompt="no"
      Timeout="10" />
  `;

  // Insert just before the first <Directory> element
  const directoryTag = '<Directory';
  const directoryIndex = xml.indexOf(directoryTag);
  if (directoryIndex !== -1) {
    xml = xml.slice(0, directoryIndex) + closeAppXml + '\n    ' + xml.slice(directoryIndex);
  }

  // --- 3. Inject cleanup of %LOCALAPPDATA% user data on uninstall ---
  // The userData folder contains msal-cache.enc, backend-data/, and Electron state.
  // This is intentional for the demo build — users expect full removal.
  const cleanupXml = `
    <!-- Remove user data directory on uninstall -->
    <Component Id="CleanupUserData" Guid="*" Directory="APPLICATIONFOLDER">
      <RegistryValue Root="HKCU" Key="Software\\MeetingNoteTaker" Name="cleanup" Type="integer" Value="1" KeyPath="yes" />
      <util:RemoveFolderEx On="uninstall" Property="LOCALAPPDATAFOLDER" />
    </Component>

    <Property Id="LOCALAPPDATAFOLDER">
      <RegistrySearch Id="FindLocalAppData" Root="HKCU" Key="Software\\MeetingNoteTaker" Name="DataPath" Type="raw" />
    </Property>

    <!-- Write the actual path during install so uninstall can find it -->
    <SetProperty Id="LOCALAPPDATAFOLDER"
      Value="[LocalAppDataFolder]meeting-notetaker-desktop"
      After="AppSearch"
      Sequence="execute" />
  `;

  // Insert before </Product>
  const productClose = '</Product>';
  const productCloseIndex = xml.indexOf(productClose);
  if (productCloseIndex !== -1) {
    xml = xml.slice(0, productCloseIndex) + cleanupXml + '\n  ' + xml.slice(productCloseIndex);
  }

  // --- 4. Add ComponentRef to ProductFeature so MSI includes the cleanup component ---
  const featureClose = '</Feature>';
  const featureCloseIndex = xml.indexOf(featureClose);
  if (featureCloseIndex !== -1) {
    xml = xml.slice(0, featureCloseIndex) +
      '  <ComponentRef Id="CleanupUserData" />\n    ' +
      xml.slice(featureCloseIndex);
  }

  fs.writeFileSync(projectFile, xml, 'utf-8');
  console.log('[msi-project-created] Injected CloseApplication + user data cleanup into WiX project');
};

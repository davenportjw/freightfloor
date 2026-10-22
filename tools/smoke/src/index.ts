export const SMOKE_VERSION = 1;

export {
  runLiveSmoke,
  wsUrlToHttpUrl,
  cleanupSmokePlayers,
  isSmokePlayerDoc,
  SMOKE_ID_PREFIX,
  openSiteAccess,
  type SiteAccess,
  type SiteAccessOptions,
  type SiteAuthMode,
  type LiveSmokeOptions,
  type LiveSmokeReport,
} from './live.js';

export {
  runArmorSmoke,
  ADVERSARIAL_INJECTIONS,
  BENIGN_COMMAND,
  type ArmorSmokeOptions,
  type ArmorSmokeReport,
  type InjectionResult,
} from './armor.js';

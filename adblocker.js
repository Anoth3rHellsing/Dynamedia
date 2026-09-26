// Dynamedia — bloqueo de anuncios + anti-redirecciones
const AD_HOST_PATTERNS = [
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.adservice.google.com/*',
  '*://*.adnxs.com/*',
  '*://*.adsrvr.org/*',
  '*://*.criteo.com/*',
  '*://*.criteo.net/*',
  '*://*.taboola.com/*',
  '*://*.outbrain.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.quantserve.com/*',
  '*://*.amazon-adsystem.com/*',
  '*://*.moatads.com/*',
  '*://*.adsafeprotected.com/*',
  '*://*.pubmatic.com/*',
  '*://*.rubiconproject.com/*',
  '*://*.openx.net/*',
  '*://*.smartadserver.com/*',
  '*://*.adroll.com/*',
  '*://*.bidswitch.net/*',
  '*://*.casalemedia.com/*',
  '*://*.yieldmo.com/*',
  '*://*.advertising.com/*',
  '*://*.zedo.com/*',
  '*://*.popads.net/*',
  '*://*.popcash.net/*',
  '*://*.adcash.com/*',
  '*://*.propellerads.com/*',
  '*://*.propelleradserving.com/*',
  '*://*.mgid.com/*',
  '*://*.revcontent.com/*',
  '*://*.adsterra.com/*',
  '*://*.exoclick.com/*',
  '*://*.juicyads.com/*',
  '*://*.trafficjunky.com/*',
  '*://*.media.net/*',
  '*://*.servenobid.com/*',
  '*://*.sharethrough.com/*',
  '*://*.3lift.com/*',
  '*://*.spotxchange.com/*',
  '*://*.teads.tv/*',
  '*://*.yieldlab.net/*',
  '*://*.adform.net/*',
  '*://*.an.yandex.ru/*',
  '*://*.ads.yahoo.com/*',
];

const AD_URL_SUBSTRINGS = [
  '/adsbygoogle',
  '/pagead/js',
  '/adframe',
  '/adserver',
  '/popunder',
  'prebid',
  '/banner-ad',
  'popunder',
  'interstitial-ad',
];

let blockedCount = 0;
let onStatsChange = null;

function isAdUrl(details) {
  const url = (details.url || '').toLowerCase();
  return AD_URL_SUBSTRINGS.some((sub) => url.includes(sub));
}

function install(ses, options = {}) {
  const urls = [...AD_HOST_PATTERNS];
  if (options.customPatterns) urls.push(...options.customPatterns);

  ses.webRequest.onBeforeRequest({ urls }, (details, callback) => {
    blockedCount++;
    notify();
    callback({ cancel: true });
  });

  // Bloqueo adicional por substring en subframes/scripts (pop-unders, redirecciones de anuncios)
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'subFrame' || details.resourceType === 'script') {
      if (isAdUrl(details)) {
        blockedCount++;
        notify();
        return callback({ cancel: true });
      }
    }
    callback({});
  });
}

function notify() {
  if (onStatsChange) onStatsChange(blockedCount);
}

function setOnStatsChange(fn) {
  onStatsChange = fn;
}

function getBlockedCount() {
  return blockedCount;
}

module.exports = { install, getBlockedCount, setOnStatsChange };
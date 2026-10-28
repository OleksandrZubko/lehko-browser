// Runs in the page's main world before site scripts. Apple M1 has no AV1 hardware
// decoder, so reporting AV1 as unsupported makes players pick hardware VP9/H.264.
(() => {
  const av1 = (type: unknown) => typeof type === 'string' && /av01/i.test(type);
  const source = globalThis.MediaSource;
  if (source) {
    const supported = source.isTypeSupported.bind(source);
    source.isTypeSupported = type => !av1(type) && supported(type);
  }
  const canPlay = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) { return av1(type) ? '' : canPlay.call(this, type); };
  const capabilities = navigator.mediaCapabilities;
  if (capabilities?.decodingInfo) {
    const decoding = capabilities.decodingInfo.bind(capabilities);
    capabilities.decodingInfo = config => av1(config?.video?.contentType)
      ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false } as MediaCapabilitiesDecodingInfo)
      : decoding(config);
  }
})();

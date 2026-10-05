/**
 * React Native configuration for RunAnywhere
 *
 * NOTE: automaticPodsInstallation is disabled because the @runanywhere packages
 * use "podspecPath" in their react-native.config.js, which is not allowed by
 * the RN 0.83 CLI. Pods must be installed manually: cd ios && pod install && cd ..
 */
module.exports = {
  project: {
    ios: {
      automaticPodsInstallation: false,
    },
  },
  dependencies: {
    // Disable packages with New Architecture compatibility issues on iOS
    'react-native-sound': {
      platforms: {
        ios: null,
      },
    },
    'react-native-audio-recorder-player': {
      platforms: {
        ios: null,
      },
    },
    // CRITICAL: react-native-screens crashes with New Architecture in RN 0.83
    // Error: -[RCTView setColor:] and -[RCTView setSheetExpandsWhenScrolledToEdge:]
    'react-native-screens': {
      platforms: {
        ios: null,
      },
    },
    // NW disabled: NobodyWho links its own llama.cpp, which the linker hands to
    // RunAnywhere's backend too. Unlinked while RunAnywhere is tested alone.
    'react-native-nobodywho': {
      platforms: {
        ios: null,
        android: null,
      },
    },
  },
};

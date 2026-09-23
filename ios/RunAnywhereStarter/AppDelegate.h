#import <RCTAppDelegate.h>
#import <UIKit/UIKit.h>

@interface AppDelegate : RCTAppDelegate

@end

// iOS 27 requires the UIScene lifecycle, so the React Native window is created per scene
// (see UIApplicationSceneManifest in Info.plist) instead of in didFinishLaunching.
@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>

@property (nonatomic, strong) UIWindow *window;

@end

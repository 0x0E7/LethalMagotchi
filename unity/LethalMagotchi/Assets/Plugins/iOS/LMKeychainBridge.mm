// Native half of IosKeychainStore.cs — see that file's docstring for the accessibility-class
// rationale (AfterFirstUnlockThisDeviceOnly: background-readable, never iCloud-synced).
//
// Compiled automatically by Unity's iOS build as part of the Xcode project (any .mm/.m/.h
// under Assets/Plugins/iOS ships that way with no extra configuration); Security.framework is
// linked automatically too, since Unity always links it for its own use. Nothing here needs a
// manual Xcode step beyond what unity/SETUP.md's iOS section names explicitly.

// `<Security/Security.h>`, not `<Security.h>`: the Keychain API lives inside the Security
// FRAMEWORK, and a framework header is addressed as <Framework/Header.h>. The bare form does not
// resolve to anything on any iOS SDK and fails the Xcode build outright at the first compile of
// this file. Foundation is imported explicitly for the same reason — Unity's generated Xcode
// project does not guarantee a prefix header that supplies NSString/NSData/NSLog to plugin
// sources, and relying on one that happens to exist today is how this breaks on an Xcode upgrade.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <string.h>

static NSData *LM_DataFromCString(const char *value) {
    if (value == NULL) {
        return nil;
    }
    return [NSData dataWithBytes:value length:strlen(value)];
}

extern "C" {

// Forward-declared because LM_KeychainSave calls it above its own definition; C++ resolves names
// top-down and will not find it otherwise.
void LM_KeychainDelete(const char *serviceC, const char *accountC);

void LM_KeychainSave(const char *serviceC, const char *accountC, const char *valueC) {
    // A managed `null` string marshals to a NULL char*, and every one of
    // +stringWithUTF8String:, strlen() and +dictionaryWithObjects: is a crash on NULL — so an
    // unexpected null refresh token in a server response would have taken the whole app down
    // inside a P/Invoke, with a native stack trace and no managed context. Guarded here as well
    // as in IosKeychainStore.Save because native code reached over a C ABI cannot assume anything
    // about its caller.
    if (serviceC == NULL || accountC == NULL) {
        NSLog(@"[LMKeychainBridge] save called with a null service/account — ignoring");
        return;
    }

    NSString *service = [NSString stringWithUTF8String:serviceC];
    NSString *account = [NSString stringWithUTF8String:accountC];
    NSData *valueData = LM_DataFromCString(valueC);
    if (valueData == nil) {
        // "Save nothing" is a delete, not a store of an empty credential.
        LM_KeychainDelete(serviceC, accountC);
        return;
    }

    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service,
        (__bridge id)kSecAttrAccount: account,
    };

    // Delete-then-add rather than SecItemUpdate: a rotated refresh token fully replaces the
    // old one (§14.5 — the old token is already revoked server-side the instant a new one is
    // issued), so there is no partial-update case worth the extra code path.
    SecItemDelete((__bridge CFDictionaryRef)query);

    NSMutableDictionary *insert = [query mutableCopy];
    insert[(__bridge id)kSecValueData] = valueData;
    insert[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;

    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)insert, NULL);
    if (status != errSecSuccess) {
        NSLog(@"[LMKeychainBridge] save failed: %d", (int)status);
    }
}

// Ownership contract matches IosKeychainStore.Load(): the caller frees this pointer with
// Marshal.FreeHGlobal, which maps to the platform free() — the correct counterpart to strdup's
// malloc() on IL2CPP/Mono. A NULL return means "nothing stored", not an error.
char *LM_KeychainLoad(const char *serviceC, const char *accountC) {
    if (serviceC == NULL || accountC == NULL) {
        return NULL;
    }
    NSString *service = [NSString stringWithUTF8String:serviceC];
    NSString *account = [NSString stringWithUTF8String:accountC];

    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service,
        (__bridge id)kSecAttrAccount: account,
        (__bridge id)kSecReturnData: @YES,
        (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
    };

    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status != errSecSuccess || result == NULL) {
        return NULL;
    }

    NSData *data = (__bridge_transfer NSData *)result;
    NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (value == nil) {
        return NULL;
    }
    return strdup([value UTF8String]);
}

void LM_KeychainDelete(const char *serviceC, const char *accountC) {
    if (serviceC == NULL || accountC == NULL) {
        return;
    }
    NSString *service = [NSString stringWithUTF8String:serviceC];
    NSString *account = [NSString stringWithUTF8String:accountC];

    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service,
        (__bridge id)kSecAttrAccount: account,
    };
    SecItemDelete((__bridge CFDictionaryRef)query);
}

} // extern "C"

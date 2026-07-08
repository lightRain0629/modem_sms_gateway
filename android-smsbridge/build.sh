#!/usr/bin/env bash
# Hand-builds the SMS Bridge APK (no gradle): javac -> d8 -> aapt package ->
# zipalign -> apksigner. Targets API 19 (KitKat) via --min-api 19 dex.
set -euo pipefail

cd "$(dirname "$0")"
SDK="$HOME/Library/Android/sdk"
BT="$SDK/build-tools/35.0.0"
ANDROID_JAR="$SDK/platforms/android-35/android.jar"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
PATH="$JAVA_HOME/bin:$PATH"

rm -rf build
mkdir -p build/classes build/apk

echo "[1/6] javac"
javac -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
  -d build/classes $(find src -name '*.java') 2>&1 | grep -v 'bootstrap class path' || true

echo "[2/6] d8 -> classes.dex"
"$BT/d8" --min-api 19 --output build/apk \
  $(find build/classes -name '*.class')

echo "[3/6] aapt package (manifest + res + dex)"
"$BT/aapt" package -f -M AndroidManifest.xml -S res -I "$ANDROID_JAR" \
  -F build/smsbridge.unaligned.apk build/apk

echo "[4/6] zipalign"
"$BT/zipalign" -f 4 build/smsbridge.unaligned.apk build/smsbridge.aligned.apk

echo "[5/6] debug keystore"
# kept OUTSIDE build/ (which is wiped each run) so the signing cert is stable
# across rebuilds — otherwise adb reinstall fails with INCONSISTENT_CERTIFICATES
KS=debug.keystore
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias sb -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=SMS Bridge" >/dev/null 2>&1
fi

echo "[6/6] apksigner"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --min-sdk-version 19 --v2-signing-enabled true \
  --out build/smsbridge.apk build/smsbridge.aligned.apk

echo "OK -> $(pwd)/build/smsbridge.apk"

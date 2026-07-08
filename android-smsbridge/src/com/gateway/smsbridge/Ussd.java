package com.gateway.smsbridge;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;

/**
 * Dials a USSD/MMI code with an ACTION_CALL intent (CALL_PHONE is held by the
 * shell package). On KitKat there is no API for the reply — it appears only in
 * a system dialog — so UssdAccessibilityService scrapes it from the screen.
 *
 * We stamp ussd.json as pending here; the accessibility service overwrites it
 * with the captured reply. A stale pending marker (no dialog appeared) is how
 * the driver detects "no reply".
 */
final class Ussd {
    static void dial(Context ctx, String code) {
        Out.write("ussd.json", "{\"status\":\"pending\",\"code\":\"" + Json.esc(code) + "\"}");
        try {
            // Encode the whole code (esp. '#' -> %23); Uri.fromParts would treat
            // '#' as a fragment separator and the dialer would see only "*222".
            Uri uri = Uri.parse("tel:" + Uri.encode(code));
            Intent call = new Intent(Intent.ACTION_CALL, uri);
            call.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(call);
            Log.i(Out.TAG, "dialed USSD " + code);
        } catch (Exception e) {
            Log.e(Out.TAG, "USSD dial failed: " + e);
            Out.write("ussd.json",
                    "{\"status\":\"failed\",\"code\":\"" + Json.esc(code)
                    + "\",\"error\":\"" + Json.esc(String.valueOf(e)) + "\"}");
        }
    }

    private Ussd() {}
}

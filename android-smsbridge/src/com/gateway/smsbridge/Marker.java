package com.gateway.smsbridge;

import android.os.Environment;

import java.io.File;
import java.io.FileInputStream;

/** Reads ussd.json to tell whether a USSD dial is in flight, so the
 *  accessibility service only scrapes dialogs during a USSD request. */
final class Marker {
    static boolean ussdPending() {
        try {
            File f = new File(new File(Environment.getExternalStorageDirectory(), Out.DIR), "ussd.json");
            if (!f.exists()) return false;
            byte[] buf = new byte[(int) f.length()];
            FileInputStream in = new FileInputStream(f);
            int n = in.read(buf);
            in.close();
            return n > 0 && new String(buf, 0, n, "UTF-8").contains("\"pending\"");
        } catch (Exception e) {
            return false;
        }
    }

    private Marker() {}
}

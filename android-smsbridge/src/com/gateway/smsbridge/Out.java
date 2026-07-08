package com.gateway.smsbridge;

import android.os.Environment;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;

/** Writes results to /sdcard/smsbridge/<name>, which the adb shell can read
 *  (shell is in the sdcard_r group). Also mirrors to logcat for debugging. */
final class Out {
    static final String TAG = "SMSBRIDGE";
    static final String DIR = "smsbridge";

    static void write(String name, String content) {
        try {
            File dir = new File(Environment.getExternalStorageDirectory(), DIR);
            if (!dir.exists()) dir.mkdirs();
            File tmp = new File(dir, name + ".tmp");
            File dst = new File(dir, name);
            FileOutputStream fos = new FileOutputStream(tmp);
            fos.write(content.getBytes("UTF-8"));
            fos.getFD().sync();
            fos.close();
            // atomic-ish swap so a reader never sees a half-written file
            tmp.renameTo(dst);
            Log.i(TAG, "wrote " + name + " (" + content.length() + " bytes)");
        } catch (Exception e) {
            Log.e(TAG, "write " + name + " failed: " + e);
        }
    }

    /** Appends a line to /sdcard/smsbridge/<name> (used for the incoming-SMS log). */
    static void append(String name, String content) {
        try {
            File dir = new File(Environment.getExternalStorageDirectory(), DIR);
            if (!dir.exists()) dir.mkdirs();
            FileOutputStream fos = new FileOutputStream(new File(dir, name), true);
            fos.write(content.getBytes("UTF-8"));
            fos.getFD().sync();
            fos.close();
        } catch (Exception e) {
            Log.e(TAG, "append " + name + " failed: " + e);
        }
    }

    private Out() {}
}

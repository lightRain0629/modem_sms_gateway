package com.gateway.smsbridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;

/**
 * Shell-triggerable entry point for the gateway's adb driver.
 *
 *   am broadcast -a com.gateway.smsbridge.DUMP_INBOX
 *   am broadcast -a com.gateway.smsbridge.RUN_USSD --es code '*222#'
 *
 * Each writes its result under /sdcard/smsbridge/ (see Out).
 */
public class BridgeReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if ("com.gateway.smsbridge.DUMP_INBOX".equals(action)) {
            dumpInbox(ctx);
        } else if ("com.gateway.smsbridge.RUN_USSD".equals(action)) {
            String code = intent.getStringExtra("code");
            Ussd.dial(ctx, code == null ? "" : code);
        }
    }

    private void dumpInbox(Context ctx) {
        StringBuilder json = new StringBuilder("[");
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(
                    Uri.parse("content://sms/inbox"),
                    new String[] {"_id", "address", "body", "date", "read"},
                    null, null, "date DESC");
            boolean first = true;
            if (c != null) {
                while (c.moveToNext()) {
                    if (!first) json.append(",");
                    first = false;
                    json.append("{\"id\":").append(c.getLong(0))
                        .append(",\"from\":\"").append(Json.esc(c.getString(1))).append("\"")
                        .append(",\"text\":\"").append(Json.esc(c.getString(2))).append("\"")
                        .append(",\"date\":").append(c.getLong(3))
                        .append(",\"read\":").append(c.getInt(4))
                        .append("}");
                }
            }
        } catch (Exception e) {
            Log.e(Out.TAG, "inbox query failed: " + e);
            Out.write("inbox.json", "{\"error\":\"" + Json.esc(String.valueOf(e)) + "\"}");
            return;
        } finally {
            if (c != null) c.close();
        }
        json.append("]");
        Out.write("inbox.json", json.toString());
    }
}

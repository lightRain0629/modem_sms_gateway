package com.gateway.smsbridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.telephony.SmsMessage;
import android.util.Log;

/**
 * Captures incoming SMS from the SMS_RECEIVED broadcast, which KitKat delivers
 * to every RECEIVE_SMS holder (not just the default SMS app — that restriction
 * is only on SMS_DELIVER). This is how the UFI gets an inbox: the device has no
 * default SMS app, so content://sms stays empty, but the raw PDUs still arrive
 * here. Each delivery is appended as one JSON line to incoming.jsonl, which the
 * gateway's adb driver drains.
 */
public class SmsReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction())) return;
        Bundle bundle = intent.getExtras();
        if (bundle == null) return;

        Object[] pdus = (Object[]) bundle.get("pdus");
        if (pdus == null || pdus.length == 0) return;
        String format = bundle.getString("format"); // may be null on older builds

        String from = null;
        long when = 0;
        StringBuilder body = new StringBuilder();
        for (Object pdu : pdus) {
            SmsMessage m = toMessage((byte[]) pdu, format);
            if (m == null) continue;
            if (from == null) from = m.getOriginatingAddress();
            when = m.getTimestampMillis();
            String part = m.getMessageBody();
            if (part != null) body.append(part); // concatenate multipart parts
        }
        if (from == null) return;

        String line = "{\"from\":\"" + Json.esc(from) + "\""
                + ",\"text\":\"" + Json.esc(body.toString()) + "\""
                + ",\"date\":" + when + "}";
        Out.append("incoming.jsonl", line + "\n");
        Log.i(Out.TAG, "captured incoming SMS from " + from);
    }

    @SuppressWarnings("deprecation")
    private SmsMessage toMessage(byte[] pdu, String format) {
        try {
            if (format != null) return SmsMessage.createFromPdu(pdu, format);
        } catch (Throwable ignore) { /* fall through to legacy */ }
        return SmsMessage.createFromPdu(pdu);
    }
}

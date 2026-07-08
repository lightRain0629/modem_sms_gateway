package com.gateway.smsbridge;

import android.accessibilityservice.AccessibilityService;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;

/**
 * Captures the USSD reply that KitKat shows only in a system AlertDialog.
 * When a dialog window appears we walk its node tree, take the longest text
 * node (the reply body, not the "OK"/"Cancel" buttons) and write it to
 * ussd.json — but only while a USSD dial is in flight (ussd.json is "pending"),
 * so unrelated dialogs don't clobber the file.
 */
public class UssdAccessibilityService extends AccessibilityService {

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        int t = event.getEventType();
        if (t != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                && t != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                && t != AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) {
            return;
        }
        // Only capture while a USSD request is pending, so we don't scrape
        // every dialog on the device.
        if (!Marker.ussdPending()) return;

        AccessibilityNodeInfo root = getRootInActiveWindow();
        String best = longestText(root);
        if (root != null) root.recycle();

        // Fall back to the event's own text (some dialogs surface it there).
        if (best == null || best.length() < 3) {
            String fromEvent = joinEventText(event);
            if (fromEvent != null && fromEvent.length() > (best == null ? 0 : best.length())) {
                best = fromEvent;
            }
        }
        if (best != null && best.length() >= 3 && !looksLikeButton(best)) {
            Log.i(Out.TAG, "USSD reply captured: " + best);
            Out.write("ussd.json",
                    "{\"status\":\"done\",\"reply\":\"" + Json.esc(best) + "\"}");
        }
    }

    private static boolean looksLikeButton(String s) {
        String l = s.trim().toLowerCase();
        return l.equals("ok") || l.equals("cancel") || l.equals("send") || l.equals("dismiss");
    }

    private String joinEventText(AccessibilityEvent event) {
        List<CharSequence> parts = event.getText();
        if (parts == null || parts.isEmpty()) return null;
        StringBuilder b = new StringBuilder();
        for (CharSequence p : parts) {
            if (p == null) continue;
            if (b.length() > 0) b.append(" ");
            b.append(p);
        }
        return b.length() == 0 ? null : b.toString();
    }

    /** Depth-first walk returning the longest text found in the window. */
    private String longestText(AccessibilityNodeInfo node) {
        if (node == null) return null;
        String best = null;
        CharSequence txt = node.getText();
        if (txt != null) best = txt.toString();
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            String childBest = longestText(child);
            if (child != null) child.recycle();
            if (childBest != null && (best == null || childBest.length() > best.length())) {
                best = childBest;
            }
        }
        return best;
    }

    @Override
    public void onInterrupt() { }
}

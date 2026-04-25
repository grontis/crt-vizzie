# led_output.py — LED output stub for crt-vizzie hardware bridge
#
# Replace the body of update_leds() with actual GPIO / rpi_ws281x calls.
# This module is the only place LED/GPIO code should live.
# pi-bridge.py imports and calls update_leds() on every received 'audio' message.
#
# To use rpi_ws281x, uncomment the import below and fill in the function body.
# from rpi_ws281x import PixelStrip, Color

def update_leds(beat_active: bool, beat_intensity: float, bands: dict) -> None:
    """
    Called each time the browser sends an 'audio' message (~16 Hz).

    Parameters
    ----------
    beat_active    : True on beat onset frames, False otherwise
    beat_intensity : float 0.0–1.0; decays ~0.9x per frame when no beat
    bands          : dict with keys sub, bass, lowMid, mid, highMid, treble (all 0.0–1.0)

    Example usage (rpi_ws281x):
        if beat_active:
            r = int(beat_intensity * 255)
            g = int(bands.get('mid', 0) * 255)
            b = int(bands.get('treble', 0) * 255)
            for i in range(strip.numPixels()):
                strip.setPixelColor(i, Color(r, g, b))
            strip.show()
    """
    pass  # TODO: rpi_ws281x / RPi.GPIO writes go here

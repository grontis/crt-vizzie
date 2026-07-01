// Raw-joystick diagnostic. Run, then press each N64 control one at a time and note the index.
//   cargo run --example input_probe
// Press in this order, pausing between each: A, B, Z, Start, L, R,
//   C-up, C-down, C-left, C-right, then the D-pad, then push the analog stick fully in each
//   direction (up/down/left/right). Ctrl-C to quit.
fn main() {
    let sdl = sdl2::init().unwrap();
    let js = sdl.joystick().unwrap();
    let mut pump = sdl.event_pump().unwrap();
    let j = js.open(0).expect("no joystick 0");
    println!("opened '{}': {} buttons, {} axes, {} hats\n", j.name(), j.num_buttons(), j.num_axes(), j.num_hats());
    use sdl2::event::Event;
    loop {
        for e in pump.wait_timeout_iter(1000) {
            match e {
                Event::JoyButtonDown { button_idx, .. } => println!("BUTTON {} pressed", button_idx),
                Event::JoyHatMotion { hat_idx, state, .. } => println!("HAT {} -> {:?}", hat_idx, state),
                Event::JoyAxisMotion { axis_idx, value, .. } => {
                    // Widen before abs: value can be i16::MIN, whose magnitude overflows i16.
                    if (value as i32).abs() > 12000 { println!("AXIS {} = {}", axis_idx, value); }
                }
                Event::Quit { .. } => return,
                _ => {}
            }
        }
    }
}

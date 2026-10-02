// A top-level X11 window to hold a plugin's GUI (CLAP plugins on Linux embed into an X11 window the
// host gives them). On a Wayland desktop it opens through XWayland.

use std::os::fd::{ AsRawFd, RawFd };

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt, CreateWindowAux, EventMask, PropMode, WindowClass };
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

pub struct X11Window {
  conn: RustConnection,
  window: u32,
  wm_protocols: u32,
  wm_delete: u32,
}

impl X11Window {
  pub fn open(title: &str, width: u32, height: u32) -> Result<Self, String> {
    let (conn, screen_num) = x11rb::connect(None).map_err(|e| format!("cannot open the X display: {}", e))?;
    let screen = &conn.setup().roots[screen_num];
    let window = conn.generate_id().map_err(|e| e.to_string())?;
    conn
      .create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        window,
        screen.root,
        0,
        0,
        width.max(1) as u16,
        height.max(1) as u16,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new().background_pixel(screen.black_pixel).event_mask(EventMask::STRUCTURE_NOTIFY)
      )
      .map_err(|e| e.to_string())?;
    let atom = |name: &str| -> Result<u32, String> {
      Ok(conn.intern_atom(false, name.as_bytes()).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?.atom)
    };
    let wm_protocols = atom("WM_PROTOCOLS")?;
    let wm_delete = atom("WM_DELETE_WINDOW")?;
    let net_wm_name = atom("_NET_WM_NAME")?;
    let utf8 = atom("UTF8_STRING")?;
    conn.change_property8(PropMode::REPLACE, window, AtomEnum::WM_NAME, AtomEnum::STRING, title.as_bytes()).map_err(|e| e.to_string())?;
    conn.change_property8(PropMode::REPLACE, window, net_wm_name, utf8, title.as_bytes()).map_err(|e| e.to_string())?;
    conn.change_property32(PropMode::REPLACE, window, wm_protocols, AtomEnum::ATOM, &[wm_delete]).map_err(|e| e.to_string())?;
    conn.map_window(window).map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    Ok(X11Window { conn, window, wm_protocols, wm_delete })
  }

  pub fn id(&self) -> u32 {
    self.window
  }

  // the connection's socket, to poll alongside the plugin's own descriptors
  pub fn fd(&self) -> RawFd {
    self.conn.stream().as_raw_fd()
  }

  pub fn resize(&self, width: u32, height: u32) {
    let _ = self.conn.configure_window(self.window, &ConfigureWindowAux::new().width(width).height(height));
    let _ = self.conn.flush();
  }

  // Handles pending events; true once the user has closed the window.
  pub fn closed(&self) -> bool {
    let mut closed = false;
    while let Ok(Some(event)) = self.conn.poll_for_event() {
      if let Event::ClientMessage(ClientMessageEvent { type_, data, .. }) = event {
        if type_ == self.wm_protocols && data.as_data32()[0] == self.wm_delete {
          closed = true;
        }
      }
    }
    closed
  }
}

impl Drop for X11Window {
  fn drop(&mut self) {
    let _ = self.conn.destroy_window(self.window);
    let _ = self.conn.flush();
  }
}

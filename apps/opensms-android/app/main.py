import os
os.environ['KIVY_GL_BACKEND'] = 'sdl2'
import sys
import json
from threading import Thread

from kivy.uix.widget import Widget
from kivy.core.clipboard import Clipboard
from kivy.lang import Builder
from kivy.core.window import Window
from kivy.utils import platform
from kivy.metrics import dp, sp
from kivy.clock import Clock
from kivy.properties import StringProperty, NumericProperty, ObjectProperty, BooleanProperty, ColorProperty

from kivymd.uix.widget import MDWidget
from kivymd.app import MDApp
from kivymd.uix.navigationbar import MDNavigationBar, MDNavigationItem
from kivymd.uix.screen import MDScreen
from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText
#from kivymd.uix.label import MDLabel
from kivymd.uix.dialog import MDDialog, MDDialogHeadlineText, MDDialogSupportingText, MDDialogButtonContainer, MDDialogContentContainer

# import screens (else pyinstaller may ignore it)
from screens.mainScr import ButtonControl
from screens.settings import SettingsBox, ApiKeyTxtbox

# import services
from services.postApi import get_api_keys, set_config_path, generate_new_api_key

# IMPORTANT: Set this property for keyboard behavior
Window.softinput_mode = "below_target"

# import platform specific modules
if platform == "android":
    from jnius import autoclass, cast
    from android.permissions import check_permission, request_permissions, Permission
else:
    from services.appSvc import app_service_thread
    from services.pathMgr import get_user_data_dir

# Local classes
class BaseMDNavigationItem(MDNavigationItem):
    icon = StringProperty()
    text = StringProperty()

class MainScreenBox(MDBoxLayout):
    top_pad = NumericProperty(0)
    bottom_pad = NumericProperty(0)
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if platform == "android":
            try:
                from android.display_cutout import get_height_of_bar
                self.top_pad = int(get_height_of_bar('status'))
                self.bottom_pad = int(get_height_of_bar('navigation'))
            except Exception as e:
                print(f"Failed android 15 padding: {e}")
                self.top_pad = 32
                self.bottom_pad = 48

## Global definitions
__version__ = "0.0.2" # App version

# Determine the base path for your application's resources
if getattr(sys, 'frozen', False):
    # Running as a PyInstaller bundle
    base_path = sys._MEIPASS
else:
    # Running in a normal Python environment
    base_path = os.path.dirname(os.path.abspath(__file__))
kv_file_path = os.path.join(base_path, 'main_layout.kv')

## Main App Class
class OpenSmsApp(MDApp):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        Window.bind(on_keyboard=self.events)
        self.txt_dialog = None
        self.wake_lock = None
        self.api_started = False
        self.key_exists = False
        self.api_key = None
        self.config_template = {
            "app": "opensms",
            "port": 9292,
            "boot": False,
        }
        self.req_template = {
            "port": 9292,
            "server": "stop",
        }

    def build(self):
        self.theme_cls.primary_palette = "Blue"
        self.theme_cls.accent_palette = "Orange"
        return Builder.load_file(kv_file_path)

    ## App logics
    def on_start(self):
        # paths setup
        file_m_height = 1
        # for android
        if platform == "android":
            file_m_height = 0.9
            from android.storage import app_storage_path
            sdk_version = 28
            try:
                VERSION = autoclass('android.os.Build$VERSION')
                sdk_version = VERSION.SDK_INT
                print(f"Android SDK: {sdk_version}")
                #self.show_toast_msg(f"Android SDK: {sdk_version}")
            except Exception as e:
                print(f"Could not check the android SDK version: {e}")
                #self.show_toast_msg(f"Error checking SDK: {e}", is_error=True)
            self.android_permissions = [Permission.WAKE_LOCK, Permission.SEND_SMS, Permission.POST_NOTIFICATIONS]
            request_permissions(self.android_permissions)
            self.internal_storage = app_storage_path()
            self.config_dir = os.path.join(self.internal_storage, 'config')
            os.makedirs(self.config_dir, exist_ok=True)
            self.request_path = os.path.join(self.config_dir, "request.json")
            self.resp_path = os.path.join(self.config_dir, "resp.json")
            if os.path.exists(self.resp_path):
                os.remove(self.resp_path) # cleans the resp
            self.write_request() # cleans the request file
            # start the listner service on Android
            try:
                self.start_service()
            except Exception as e:
                print(f"Error while starting android service: {e}")
        # non android platforms
        else:
            self.internal_storage = get_user_data_dir(self.config_template["app"])
            self.config_dir = os.path.join(self.internal_storage, 'config')
            os.makedirs(self.config_dir, exist_ok=True)
            self.request_path = os.path.join(self.config_dir, "request.json")
            self.resp_path = os.path.join(self.config_dir, "resp.json")
            self.write_request()
            Thread(target=app_service_thread, daemon=True).start()
        # All generic things
        set_config_path(self.config_dir)
        self.app_config = os.path.join(self.config_dir, "config.json")
        auto_start_sw = self.root.ids.settings_scr.ids.auto_start_sw
        port_no_inp = self.root.ids.settings_scr.ids.port_no_inp
        if os.path.exists(self.app_config):
            with open(self.app_config, "r") as cf:
                saved_config = json.load(cf)
            self.config_template["port"] = int(saved_config["port"])
            self.config_template["boot"] = saved_config["boot"]
            print(f"start config check: {self.config_template}")
            self.req_template["port"] = int(self.config_template["port"])
            start_on_launch = self.config_template["boot"]
            if start_on_launch:
                self.req_template["server"] = "start"
                auto_start_sw.active = True
                Thread(target=self.write_request, daemon=True).start()
            else:
                auto_start_sw.active = False
        else:
            self.write_app_conf()
        port_no_inp.text = str(self.config_template["port"])
        api_keys = get_api_keys()
        if len(api_keys) >= 1:
            self.key_exists = True
        Thread(target=self.resp_check_loop, daemon=True).start()
        print("Init success...")

    def start_service(self):
        PythonActivity = autoclass('org.kivy.android.PythonActivity')
        mActivity = PythonActivity.mActivity
        service = autoclass('in.daslearning.opensms.ServiceOpensmssvc')
        #argument = ''
        argument = os.environ.get('PYTHON_SERVICE_ARGUMENT', '')
        print(f"PYTHON_SERVICE_ARGUMENT: {argument}")
        #service.start(mActivity, argument)
        service.start(mActivity, 'icon', 'OpenSMS API', 'Service Running' , argument)

    def stop_service(self):
        service = autoclass('in.daslearning.opensms.ServiceOpensmssvc')
        PythonActivity = autoclass('org.kivy.android.PythonActivity')
        mActivity = PythonActivity.mActivity
        service.stop(mActivity)

    def resp_check_loop(self):
        import time
        api_srv_btn = self.root.ids.home_scr.ids.api_srv_btn
        api_srv_lbl = self.root.ids.home_scr.ids.api_srv_lbl
        time.sleep(0.5) # A delay for the android service to kick in
        while True:
            resp = None
            if os.path.exists(self.resp_path):
                try:
                    with open(self.resp_path, "r") as rf:
                        resp = json.load(rf)
                    if resp:
                        server_stat = resp.get("server", "")
                        if server_stat == "started":
                            if not self.api_started:
                                self.api_started = True
                                api_srv_lbl.text = f"API Server running on port: {self.req_template["port"]}"
                                api_srv_btn.btn_icon = "stop"
                                api_srv_btn.btn_txt = "Stop Server"
                                api_srv_btn.md_bg_color = "orange"
                                Clock.schedule_once(lambda dt: self.show_toast_msg("API Server Started"))
                        elif server_stat == "stopped":
                            if self.api_started:
                                self.api_started = False
                                api_srv_lbl.text = "API Server is not running"
                                api_srv_btn.btn_icon = "play"
                                api_srv_btn.btn_txt = "Start Server"
                                api_srv_btn.md_bg_color = "green"
                                Clock.schedule_once(lambda dt: self.show_toast_msg("API Server Stopped"))
                except Exception as e:
                    print(f"Error while reading resp: {e}")
            time.sleep(2)

    def write_app_conf(self):
        with open(self.app_config, "w") as cf:
            json.dump(self.config_template, cf)

    def write_request(self):
        with open(self.request_path, "w") as rf:
            json.dump(self.req_template, rf)

    def api_server_mgr(self, instance=None):
        permissions_ok = self.check_request_android_permission()
        if not permissions_ok:
            return
        key_ok = self.check_if_key_exists()
        if key_ok:
            if not self.api_started:
                self.req_template["server"] = "start"
                self.write_request()
            else:
                self.req_template["server"] = "stop"
                self.write_request()
        else:
            self.new_api_key_pop()

    def check_request_android_permission(self):
        if platform == "android":
            permission_flag = True
            for permission in self.android_permissions:
                tmp_flag = check_permission(permission)
                if not tmp_flag:
                    permission_flag = False
                    break
            if not permission_flag:
                request_permissions(self.android_permissions, self.permission_callback)
            return permission_flag
        else:
            return True

    def permission_callback(self, permissions, results):
        # results is a list of booleans corresponding to requested permissions
        usr_deny_flag = False
        if False in results:
            # the user checked "Don't ask again" or denied it twice.
            PythonActivity = autoclass('org.kivy.android.PythonActivity')
            current_activity = PythonActivity.mActivity
            # Check rationale status via Android API
            for permission in permissions:
                should_show = current_activity.shouldShowRequestPermissionRationale(permission)
                if not should_show:
                    usr_deny_flag = True
                    break
            if usr_deny_flag:
                # User denied twice / blocked permanently! Show redirect popup.
                print("Permission is denied by user!")
                Clock.schedule_once(lambda dt: self.show_settings_popup())

    def show_settings_popup(self):
        buttons = MDDialogButtonContainer(
            Widget(),
            MDButton(
                MDButtonText(
                    text="Cancel"
                ),
                style="text",
                on_release=self.txt_dialog_closer
            ),
            MDButton(
                MDButtonText(
                    text="Open Settings",
                    theme_text_color= "Custom",
                    text_color= "orange"
                ),
                style="text",
                on_release=self.open_android_settings
            ),
            spacing="8dp",
        )
        self.show_text_dialog(
            "Permissions Missing",
            "You need to grant the SMS & Notifications permissions from Settings.",
            None,
            buttons
        )

    def open_android_settings(self, instance=None):
        self.txt_dialog_closer()
        # Target Android Native Intents
        Intent = autoclass('android.content.Intent')
        Settings = autoclass('android.provider.Settings')
        Uri = autoclass('android.net.Uri')
        PythonActivity = autoclass('org.kivy.android.PythonActivity')
        # Create intent to open this specific app's settings details
        activity = PythonActivity.mActivity
        intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        uri = Uri.fromParts("package", activity.getPackageName(), None)
        intent.setData(uri)
        # Launch settings
        activity.startActivity(intent)

    def check_if_key_exists(self):
        api_keys = get_api_keys()
        if len(api_keys) >= 1:
            self.key_exists = True
        else:
            self.key_exists = False
        return self.key_exists

    def new_api_key_pop(self):
        buttons = MDDialogButtonContainer(
            Widget(),
            MDButton(
                MDButtonText(
                    text="Cancel"
                ),
                style="text",
                on_release=self.txt_dialog_closer
            ),
            MDButton(
                MDButtonText(
                    text="Generate",
                    theme_text_color= "Custom",
                    text_color= "green"
                ),
                style="text",
                on_release=self.create_new_api_key
            ),
            spacing="8dp",
        )
        self.show_text_dialog(
            "Generate API Key",
            "Do you want to generate the a new API key? This will make old keys invalid.",
            None,
            buttons
        )

    def create_new_api_key(self, instance=None):
        self.txt_dialog_closer()
        self.api_key = generate_new_api_key()
        if self.api_key:
            Clipboard.copy(self.api_key)
            custom = MDDialogContentContainer(
                ApiKeyTxtbox(
                    text = self.api_key
                )
            )
            buttons = MDDialogButtonContainer(
                Widget(),
                MDButton(
                    MDButtonText(
                        text="Cancel"
                    ),
                    style="text",
                    on_release=self.txt_dialog_closer
                ),
                MDButton(
                    MDButtonText(
                        text="Copy",
                        theme_text_color= "Custom",
                        text_color= "green"
                    ),
                    style="text",
                    on_release=self.copy_api_key
                ),
                spacing="8dp",
            )
            self.show_text_dialog(
                "Your New API Key",
                "The key is already copied, you can paste anywhere. This screen appears only once, make sure you copy the key securely!",
                custom,
                buttons
            )
        else:
            Clock.schedule_once(lambda dt: self.show_toast_msg("Failed to generate API key, try again!", is_error=True))

    def copy_api_key(self, instance=None):
        if self.api_key:
            Clipboard.copy(self.api_key)
        self.txt_dialog_closer()
        Clock.schedule_once(lambda dt: self.show_toast_msg("API Key has been copied, store it securely."))

    ## Settings sections
    def save_settings(self, instance=None, control_txt="none"):
        port_no_inp = self.root.ids.settings_scr.ids.port_no_inp
        flag = False
        if control_txt == "switch":
            if self.config_template["boot"]:
                self.config_template["boot"] = False
                flag = True
            else:
                self.config_template["boot"] = True
                flag = True
        if port_no_inp.text != "":
            port_no = int(port_no_inp.text)
            if port_no >= 1025:
                self.config_template["port"] = port_no
                self.req_template["port"] = port_no
        print(f"Service on start: {self.config_template["boot"]}, port: {self.config_template["port"]}")
        Thread(target=self.write_app_conf, daemon=True).start()
        Clock.schedule_once(lambda dt: self.show_toast_msg("Settings has been saved."))

    def refresh_settings_view(self):
        auto_start_sw = self.root.ids.settings_scr.ids.auto_start_sw
        port_no_inp = self.root.ids.settings_scr.ids.port_no_inp
        if self.config_template["boot"]:
            auto_start_sw.active = True
        else:
            auto_start_sw.active = False
        port_no_inp.text = str(self.config_template["port"])

    def reset_settings(self, instance=None):
        self.config_template = {
            "port": 9292,
            "boot": False,
        }
        self.req_template["port"] = 9292
        print("Settings reset has been done!")
        self.refresh_settings_view()
        Thread(target=self.write_app_conf, daemon=True).start()
        Clock.schedule_once(lambda dt: self.show_toast_msg("Settings reset has been done!"))

    ## App or UI related things
    def acquire_wakelock(self):
        if self.wake_lock:
            return  # already acquired
        try:
            PythonActivity = autoclass("org.kivy.android.PythonActivity")
            Context = autoclass("android.content.Context")
            activity = PythonActivity.mActivity
            PowerManager = autoclass("android.os.PowerManager")
            power_manager = cast(PowerManager, activity.getSystemService(Context.POWER_SERVICE))
            # Create wakelock (use PowerManager.FULL_WAKE_LOCK for full wakelock)
            self.wake_lock = power_manager.newWakeLock(
                PowerManager.FULL_WAKE_LOCK, "OpenSmsApp::WakeLockTag"
            )
            self.wake_lock.acquire()
            print("WakeLock acquired")
        except Exception as e:
            print(f"Wake lock aquire error: {e}")

    def release_wakelock(self):
        if self.wake_lock and self.wake_lock.isHeld():
            self.wake_lock.release()
            self.wake_lock = None
            print("WakeLock released")

    def show_toast_msg(self, message, is_error=False, duration=3):
        from kivymd.uix.snackbar import MDSnackbar, MDSnackbarText, MDSnackbarSupportingText
        bg_color = (0.2, 0.6, 0.2, 1) if not is_error else (0.8, 0.2, 0.2, 1)
        MDSnackbar(
            MDSnackbarText(
                text=message,
            ),
            y=dp(24),
            orientation="horizontal",
            pos_hint={"center_x": 0.5},
            background_color=bg_color,
        ).open()

    def show_text_dialog(
            self, 
            title, 
            text="", 
            custom_content:MDDialogContentContainer|None = None, 
            buttons:MDDialogButtonContainer|None = None
        ):
        self.txt_dialog = MDDialog(
            MDDialogHeadlineText(
                text = title
            ),
            MDDialogSupportingText(
                text = text
            ),
            custom_content,
            buttons
        )
        self.txt_dialog.open()

    def txt_dialog_closer(self, instance=None):
        if self.txt_dialog:
            self.txt_dialog.dismiss()

    def goto_app_settings(self, instance=None):
        self.txt_dialog_closer()
        self.go_to_screen("Settings")

    def goto_logs_screen(self, instance=None):
        self.go_to_screen("Logs")

    def go_to_screen(self, screen:str):
        self.root.ids.screen_manager.current = screen

    def on_main_screen_entry(self, instance=None):
        self.root.ids.top_back_btn.opacity = 0
        self.root.ids.top_back_btn.disabled = True

    def on_settings_entry(self, instance=None):
        self.root.ids.top_back_btn.opacity = 1
        self.root.ids.top_back_btn.disabled = False

    def back_button_action(self, instance=None):
        if self.root.ids.screen_manager.current == "Settings":
           self.go_to_screen("SMS")

    def events(self, instance, keyboard, keycode, text, modifiers):
        """Handle mobile device button presses (e.g., Android back button)."""
        if keyboard in (1001, 27):
            if self.root.ids.screen_manager.current == "Settings":
               self.go_to_screen("SMS")
               return True
        # exits from app
        return False

    # run on app exit
    def on_stop(self):
        print("Exiting the app...")
        if platform == "android":
            self.stop_service()
            self.release_wakelock()

    # on bottom navigation
    def on_switch_tabs(
            self,
            bar: MDNavigationBar,
            item: MDNavigationItem,
            item_icon: str,
            item_text: str,
        ):
            self.root.ids.screen_manager.current = item_text


if __name__ == '__main__':
    OpenSmsApp().run()

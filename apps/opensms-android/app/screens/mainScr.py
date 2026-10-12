from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText

from kivy.lang import Builder
from kivy.uix.widget import Widget
from kivy.properties import StringProperty, NumericProperty, ObjectProperty, ColorProperty
from kivy.metrics import dp, sp
from kivy.utils import platform

Builder.load_string('''
<ButtonControl>
    pos_hint: {"center_x": .5}
    theme_bg_color: "Custom"
    md_bg_color: self.btn_colour
    MDButtonIcon:
        icon: root.btn_icon
    MDButtonText:
        text: root.btn_txt

<AppHomeBox>:
    orientation: 'vertical'
    #md_bg_color: '#7643a8'
    spacing: dp(8)
    padding: 8, 2, 8, 2

    MDLabel:
        id: api_srv_lbl
        text: "API Server is not running"
        halign: "center"
        adaptive_height: True

    ButtonControl:
        id: api_srv_btn
        style: "filled"
        on_release: app.api_server_mgr(self)

    Widget:
        size_hint_y: 1

''')

class AppHomeBox(MDBoxLayout):
    pass

class ButtonControl(MDButton):
    btn_icon = StringProperty("play")
    btn_txt = StringProperty("Start Server")
    top_pad = NumericProperty(0)
    bottom_pad = NumericProperty(0)
    btn_colour = "green"
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

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
    btn_colour = "green"

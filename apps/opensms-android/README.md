<p align="center"><img width="20%" src="app/data/images/favicont512.png" /></p>

# 📨 OpenSMS

[![CI](https://github.com/innotelinc/OpenSMS-Android/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/OpenSMS-Android/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

An open-source solution to host a `SMS` API server locally.

### 🤔 Why would you choose our app? (Features)
👉 Turns your `Android` phone into a SMS API server. <br>
👉 Open-source, No advertisements and privacy focused.

## Why OpenSMS

| Problem | Answer |
| --- | --- |
| An SMS gateway is a monthly bill and a third party. | A phone you already own is the gateway, on your own network. |
| Inbound messages disappear into a handset. | The API delivers them to the service that needs them. |
| Messaging tools want a cloud account. | There is no account and no telemetry; the device is the boundary. |

Its place in the stack is [docs/stack.md](docs/stack.md); the canonical
definition of the shared layers is the
[Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).

## 💰 Sponsor Me
You can buy me a coffee via [this link](https://www.paypal.com/paypalme/soomnathsdas) or tap on below image. Thank you 🙏. <br>
<a href="https://www.paypal.com/paypalme/soomnathsdas"><img src="./docs/images/donate.svg" height="40"></a>

## 📽️ Demo
You can click on the below Image or this [Youtube Link](https://www.youtube.com/watch?v=wNXH_3onjfg) to see the demo. Please let me know in the comments, how do you feel about this App. <br>

<a href="https://www.youtube.com/watch?v=wNXH_3onjfg"><img src="docs/images/OpenSmsThumb.webp" width="70%"></a>

## 🧑‍💻 Quickstart Guide

### 📱 Download & Run the Android App
1. You can check the [Releases](https://github.com/daslearning-org/OpenSMS/releases) and downlaod the latest version of the android app on your phone.
2. You may need to disable (temporarily) `Play Protect` from your `Play Store` settings.
3. Install the App & launch.
4. Grant the permissions.
5. Android might block `sms` permission. Go to `Settings` > `Apps` > `OpenSMS` > Tap on three vertical-dots at top-right corner > `Allow restricted access`.
6. Then grant `SMS` permission from the settings window.
7. Relaunch the app. 
8. Click `Start Server`. It will then prompt you to generate an API Key for the first time. Generate and store it securely.

### 🧪 Test API endpoint
Find the network address of your device and you may test out the API. Sample given below.

```bash
curl -i -X POST 'http://127.0.0.1:9292/sms/' \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer my-secret-api-key' \
    -d '{"number": "+1234567890", "text": "Hello from OpenSMS API!"}'
```

## 📚 Tech Stack Used

### Python stack
It works on `Android` and will bring this to `Linux` & `Windows` too.
- [FastAPI](https://github.com/fastapi/fastapi) for the API layer.
- [KivyMD](https://github.com/kivymd/kivymd) and few [Kivy](https://github.com/kivy) components for the UI and building the app.

### 📋 Future plans

1. Bring this SMS API option to Desktop platforms. We will leverage [Quectel EC200U](https://www.quectel.com/product/lte-ec200u-series/) based USB development boards to send SMS.

-----

## 🧩 Building your app from code

### 📱 Build Android App
A Linux environment is recommended for the app development. If you are on Windows, you may use `WSL` or any `Virtual Machine`.

```bash
# add the python repository (Optional: if you want some other versions)
sudo add-apt-repository ppa:deadsnakes/ppa
sudo apt update

# install all dependencies.
sudo apt install -y ant autoconf automake ccache cmake g++ gcc lbzip2 libffi-dev libltdl-dev libtool libssl-dev make openjdk-17-jdk patch patchelf pkg-config unzip wget zip git python3 python3-venv python3-dev libcairo2-dev pkg-config libjpeg-dev zlib1g-dev

# optionally you may check the java installation with below commands
java -version
javac -version

# install python modules
git clone https://github.com/daslearning-org/OpenSMS.git
cd OpenSMS/app
python3 -m venv .env # create python virtual environment
source .env/bin/activate
pip install -r req_android.txt

# build the android apk
buildozer android debug # this may take a good amount of time for the first time & will generate the apk in the bin directory
```

-----

### Linux Dependencies for build
```bash
sudo apt install libcairo2-dev pkg-config python3-dev
sudo apt-get install libjpeg-dev zlib1g-dev
```

## License

Apache-2.0 — see [LICENSE](LICENSE). Copyright © 2026 Innotel Inc. and the
upstream authors. Upstream material remains under its own licence.

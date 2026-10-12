# OpenSMS
An open-source app which can turn your `Android` phone into a `SMS API Server`.


#### Test API endpoint
```bash
curl -i -X POST 'http://127.0.0.1:9292/sms/' \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer my-secret-api-key' \
    -d '{"number": "+1234567890", "text": "Hello from OpenSMS API!"}'
```

#### Linux Dependencies for build
```bash
sudo apt install libcairo2-dev pkg-config python3-dev
sudo apt-get install libjpeg-dev zlib1g-dev
```

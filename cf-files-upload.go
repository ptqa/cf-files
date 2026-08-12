package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const defaultServiceURL = "https://file.bebekgenius.com"

type uploadRequest struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
}

type uploadResponse struct {
	UploadURL string `json:"upload_url"`
	Markdown  string `json:"markdown"`
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: cf-files-upload <file>")
		os.Exit(2)
	}

	token := os.Getenv("CF_UPLOAD_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "CF_UPLOAD_TOKEN is not set")
		os.Exit(2)
	}

	file, err := os.Open(os.Args[1])
	if err != nil {
		fail(err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		fail(err)
	}

	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(file.Name())))
	if contentType == "" {
		var header [512]byte
		n, readErr := file.Read(header[:])
		if readErr != nil && readErr != io.EOF {
			fail(readErr)
		}
		contentType = http.DetectContentType(header[:n])
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			fail(err)
		}
	}
	contentType, _, err = mime.ParseMediaType(contentType)
	if err != nil {
		fail(err)
	}

	payload, err := json.Marshal(uploadRequest{
		Filename:    filepath.Base(file.Name()),
		ContentType: contentType,
	})
	if err != nil {
		fail(err)
	}

	serviceURL := strings.TrimRight(os.Getenv("CF_FILES_URL"), "/")
	if serviceURL == "" {
		serviceURL = defaultServiceURL
	}
	req, err := http.NewRequest(http.MethodPost, serviceURL+"/v1/uploads", bytes.NewReader(payload))
	if err != nil {
		fail(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	response, err := http.DefaultClient.Do(req)
	if err != nil {
		fail(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		fail(fmt.Errorf("signing request failed: %s", response.Status))
	}

	var signed uploadResponse
	if err = json.NewDecoder(response.Body).Decode(&signed); err != nil {
		fail(err)
	}
	response.Body.Close()
	if signed.UploadURL == "" || signed.Markdown == "" {
		fail(fmt.Errorf("signing response is incomplete"))
	}

	req, err = http.NewRequest(http.MethodPut, signed.UploadURL, file)
	if err != nil {
		fail(err)
	}
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = info.Size()
	response, err = http.DefaultClient.Do(req)
	if err != nil {
		fail(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		fail(fmt.Errorf("upload failed: %s", response.Status))
	}

	fmt.Println(signed.Markdown)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "cf-files-upload:", err)
	os.Exit(1)
}

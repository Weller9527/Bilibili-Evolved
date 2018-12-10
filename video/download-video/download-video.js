(() =>
{
    return (_, resources) =>
    {
        const VideoInfo = resources.attributes.videoInfo.export.VideoInfo;
        const BangumiInfo = resources.attributes.videoInfo.export.BangumiInfo;
        const pageData = {
            aid: undefined,
            cid: undefined,
            isBangumi: false,
            isMovie: false
        };
        class VideoFormat
        {
            constructor(quality, internalName, displayName)
            {
                this.quality = quality;
                this.internalName = internalName;
                this.displayName = displayName;
            }
            async downloadInfo()
            {
                const videoInfo = new VideoDownloadInfo(this);
                await videoInfo.fetchVideoInfo();
                return videoInfo;
            }
            static get availableFormats()
            {
                return new Promise((resolve, reject) =>
                {
                    const url = `https://api.bilibili.com/x/player/playurl?avid=${pageData.aid}&cid=${pageData.cid}&otype=json`;
                    const xhr = new XMLHttpRequest();
                    xhr.addEventListener("load", () =>
                    {
                        const json = JSON.parse(xhr.responseText);
                        if (json.code !== 0)
                        {
                            reject("获取清晰度信息失败.");
                        }
                        const data = json.data;
                        const qualities = data.accept_quality;
                        const internalNames = data.accept_format.split(",");
                        const displayNames = data.accept_description;
                        const formats = [];
                        while (qualities.length > 0)
                        {
                            const format = new VideoFormat(
                                qualities.pop(),
                                internalNames.pop(),
                                displayNames.pop()
                            );
                            formats.push(format);
                        }
                        resolve(formats);
                    });
                    xhr.addEventListener("error", () => reject(`获取清晰度信息失败.`));
                    xhr.withCredentials = true;
                    xhr.open("GET", url);
                    xhr.send();
                });
            }
        }
        class VideoDownloadInfoFragment
        {
            constructor(length, size, url, backupUrls)
            {
                this.length = length;
                this.size = size;
                this.url = url;
                this.backupUrls = backupUrls;
            }
        }
        class VideoDownloadInfo
        {
            constructor(format, fragments)
            {
                this.format = format;
                this.fragments = fragments || [];
                this.progress = null;
                this.loaded = 0;
                this.totalSize = null;
                this.workingXhr = null;
                this.fragmentSplitFactor = 6 * 5;
            }
            fetchVideoInfo()
            {
                return new Promise((resolve, reject) =>
                {
                    const url = `https://api.bilibili.com/x/player/playurl?avid=${pageData.aid}&cid=${pageData.cid}&qn=${this.format.quality}&otype=json`;
                    const xhr = new XMLHttpRequest();
                    xhr.addEventListener("load", () =>
                    {
                        const data = JSON.parse(xhr.responseText.replace(/http:/g, "https:")).data;
                        if (data.quality !== this.format.quality)
                        {
                            reject("获取下载链接失败, 请确认当前账号有下载权限后重试.");
                        }
                        const urls = data.durl;
                        this.fragments = urls.map(it => new VideoDownloadInfoFragment(
                            it.length, it.size,
                            it.url,
                            it.backup_url
                        ));
                        // if (this.fragments.length > 1)
                        // {
                        //     reject("暂不支持分段视频的下载.");
                        // }
                        resolve(this.fragments);
                    });
                    xhr.withCredentials = true;
                    xhr.open("GET", url);
                    xhr.send();
                });
            }
            cancelDownload()
            {
                if ("forEach" in this.workingXhr)
                {
                    this.workingXhr.forEach(it => it.abort());
                }
                else
                {
                    logError("Cancel Download Failed: forEach in this.workingXhr not found.");
                }
            }
            downloadFragment(fragment)
            {
                const promises = [];
                this.workingXhr = [];
                const partialLength = Math.round(fragment.size / this.fragmentSplitFactor);
                let startByte = 0;
                while (startByte < fragment.size)
                {
                    const range = `bytes=${startByte}-${Math.min(fragment.size - 1, Math.round(startByte + partialLength))}`;
                    promises.push(new Promise((resolve, reject) =>
                    {
                        let loaded = 0;
                        const xhr = new XMLHttpRequest();
                        xhr.open("GET", fragment.url);
                        xhr.responseType = "arraybuffer";
                        xhr.withCredentials = false;
                        xhr.addEventListener("progress", (e) =>
                        {
                            this.loaded += e.loaded - loaded;
                            loaded = e.loaded;
                            this.progress && this.progress(this.loaded / this.totalSize);
                        });
                        xhr.addEventListener("load", () =>
                        {
                            if (("" + xhr.status)[0] === "2")
                            {
                                resolve(xhr.response);
                            }
                            else
                            {
                                reject(`请求失败.`);
                            }
                        });
                        xhr.addEventListener("abort", () => reject("下载已取消."));
                        xhr.addEventListener("error", () => reject(`下载失败.`));
                        xhr.setRequestHeader("Range", range);
                        xhr.send();
                        this.workingXhr.push(xhr);
                    }));
                    startByte = Math.round(startByte + partialLength);
                }
                return Promise.all(promises);
            }
            copyUrl()
            {
                const urls = this.fragments.map(it => it.url).reduce((acc, it) => acc + "\r\n" + it);
                GM_setClipboard(urls, "text");
            }
            extension(fragment)
            {
                return (fragment || this.fragments[0]).url
                    .indexOf(".flv") !== -1
                    ? ".flv"
                    : ".mp4";
            }
            makeBlob(data, fragment = null)
            {
                return new Blob(Array.isArray(data) ? data : [data], {
                    type: this.extension(fragment) === ".flv" ? "video/x-flv" : "video/mp4"
                });
            }
            cleanUpOldBlobUrl()
            {
                const oldBlobUrl = $("a#video-complete").attr("href");
                if (oldBlobUrl && $(`.link[href=${oldBlobUrl}]`).length === 0)
                {
                    URL.revokeObjectURL(oldBlobUrl);
                }
            }
            downloadSingle(downloadedData)
            {
                const [data] = downloadedData;
                const blob = this.makeBlob(data);
                const filename = document.title.replace("_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili", "") + this.extension();
                return [blob, filename];
            }
            async downloadMultiple(downloadedData)
            {
                const zip = new JSZip();
                const title = document.title.replace("_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili", "");
                if (downloadedData.length > 1)
                {
                    downloadedData.forEach((data, index) =>
                    {
                        const fragment = this.fragments[index];
                        zip.file(`${title} - ${index + 1}${this.extension(fragment)}`, this.makeBlob(data, fragment));
                    });
                }
                else
                {
                    const [data] = downloadedData;
                    zip.file(`${title}${this.extension()}`, this.makeBlob(data));
                }
                const blob = await zip.generateAsync({ type: "blob" });
                const filename = title + ".zip";
                return [blob, filename];
            }
            async download()
            {
                const downloadedData = [];
                this.loaded = 0;
                this.totalSize = this.fragments.map(it => it.size).reduce((acc, it) => acc + it);
                for (const fragment of this.fragments)
                {
                    const data = await this.downloadFragment(fragment);
                    downloadedData.push(data);
                }
                if (downloadedData.length < 1)
                {
                    throw new Error("下载失败.");
                }

                let blob = null;
                let filename = null;
                if (downloadedData.length === 1)
                {
                    [blob, filename] = this.downloadSingle(downloadedData);
                }
                else
                {
                    [blob, filename] = await this.downloadMultiple(downloadedData);
                }

                const blobUrl = URL.createObjectURL(blob);
                this.cleanUpOldBlobUrl();
                this.progress && this.progress(0);
                return {
                    url: blobUrl,
                    filename: filename
                };
            }
        }
        async function loadPageData()
        {
            const result = await (async () =>
            {
                let aid = (unsafeWindow || window).aid;
                let cid = (unsafeWindow || window).cid;
                if (aid === undefined || cid === undefined)
                {
                    const aidMatch = document.URL.match(/\/av(\d+)/);
                    const epMatch = document.URL.match(/\/ep(\d+)/);
                    if (aidMatch && aidMatch[1])
                    {
                        const info = await new VideoInfo(aidMatch[1]).fetchInfo();
                        aid = info.aid;
                        cid = info.cid;
                    }
                    // TODO: Download bangumi, the legacy method not work...
                    // else if (epMatch && epMatch[1])
                    // {
                    //     const info = await new BangumiInfo(epMatch[1]).fetchInfo();
                    //     aid = info.aid;
                    //     cid = info.cid;
                    // }
                }
                return [aid, cid];
            })();
            const [aid, cid] = result;
            pageData.aid = aid;
            pageData.cid = cid;
            return aid !== undefined && cid !== undefined;
        }
        async function loadWidget()
        {
            await loadPageData();
            const formats = await VideoFormat.availableFormats;
            let [selectedFormat] = formats;
            const getVideoInfo = () => selectedFormat.downloadInfo().catch(error =>
            {
                $(".download-video-panel").addClass("error");
                $(".video-error").text(error);
            });
            async function download()
            {
                if (!selectedFormat)
                {
                    return;
                }
                $(".download-video-panel")
                    .removeClass("action")
                    .addClass("progress");
                const info = await getVideoInfo();
                info.progress = percent =>
                {
                    $(".download-progress-value").text(`${fixed(percent * 100)}`);
                    $(".download-progress-foreground").css("transform", `scaleX(${percent})`);
                };
                document.querySelector(".download-progress-cancel>span").onclick = () => info.cancelDownload();
                const result = await info.download()
                    .catch(error =>
                    {
                        $(".download-video-panel").addClass("error");
                        $(".video-error").text(error);
                    });
                if (!result) // canceled or other errors
                {
                    return;
                }
                const completeLink = document.getElementById("video-complete");
                completeLink.setAttribute("href", result.url);
                completeLink.setAttribute("download", result.filename);
                completeLink.click();

                const message = `下载完成. <a class="link" href="${result.url}" download="${result.filename}">再次保存</a>`;
                Toast.success(message, "下载视频");

                $(".download-video-panel")
                    .removeClass("progress")
                    .addClass("quality");
            }
            async function copyLink()
            {
                if (!selectedFormat)
                {
                    return;
                }
                const info = await getVideoInfo();
                info.copyUrl();
                Toast.success("已复制链接到剪贴板.", "复制链接", 3000);
                $(".download-video-panel")
                    .removeClass("action")
                    .addClass("quality");
            }
            $(".video-action>#video-action-download").on("click", download);
            $(".video-action>#video-action-copy").on("click", copyLink);
            formats.forEach(format =>
            {
                $(`<li>${format.displayName}</li>`)
                    .on("click", () =>
                    {
                        selectedFormat = format;
                        $(".download-video-panel")
                            .removeClass("quality")
                            .addClass("action");
                    })
                    .prependTo("ol.video-quality");
            });
            resources.applyStyle("downloadVideoStyle");
            const downloadPanel = document.querySelector(".download-video-panel");
            const togglePopup = () => $(".download-video-panel").toggleClass("opened");
            $("#download-video").on("click", e =>
            {
                if (!downloadPanel.contains(e.target))
                {
                    togglePopup();
                }
            });
            $(".video-error").on("click", () =>
            {
                $(".video-error").text("");
                $(".download-video-panel")
                    .removeClass("error")
                    .removeClass("progress")
                    .addClass("quality");
            });
        }
        return {
            widget:
            {
                content: resources.data.downloadVideoDom.text,
                condition: loadPageData,
                success: loadWidget,
            },
        };
    };
})();
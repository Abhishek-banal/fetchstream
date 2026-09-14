/**
 * FetchStream Client-Side Zip Builder
 * Uses OPFS (Origin Private File System) and native CompressionStream
 * to stream zip files to disk without exhausting JS heap memory.
 */

class ZipBuilder {
    constructor() {
        this.files = [];
        this.crcTable = ZipBuilder.makeCRCTable();
        this.opfsRoot = null;
        this.opfsFileHandle = null;
        this.opfsWritable = null;
        this.offset = 0;
        this.tempFileName = `zip_temp_${Date.now()}_${Math.random().toString(36).substring(2,8)}.tmp`;
    }

    async init() {
        if (!this.opfsRoot) {
            this.opfsRoot = await navigator.storage.getDirectory();
            this.opfsFileHandle = await this.opfsRoot.getFileHandle(this.tempFileName, { create: true });
            this.opfsWritable = await this.opfsFileHandle.createWritable();
        }
    }

    static makeCRCTable() {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c >>> 0;
        }
        return table;
    }

    updateCRC32(crc, uint8Array) {
        for (let i = 0; i < uint8Array.length; i++) {
            crc = (crc >>> 8) ^ this.crcTable[(crc ^ uint8Array[i]) & 0xFF];
        }
        return crc;
    }

    async writeChunk(buffer) {
        if (buffer && buffer.byteLength > 0) {
            await this.opfsWritable.write(buffer);
            this.offset += buffer.byteLength;
        }
    }

    /**
     * Add a file to the zip.
     * @param {string} path - Relative path inside zip (e.g. "folder/sub/file.txt")
     * @param {Blob|Uint8Array|string} data - File data
     */
    async addFile(path, data) {
        await this.init();

        const nameBytes = new TextEncoder().encode(path.replace(/\\/g, '/').replace(/^\/+/, ''));
        const date = new Date();
        const dosTime = ZipBuilder.toDosDateTime(date);
        
        let readableStream;
        if (data instanceof Blob) {
            readableStream = data.stream();
        } else if (data instanceof Uint8Array) {
            readableStream = new Blob([data]).stream();
        } else if (typeof data === 'string') {
            readableStream = new Blob([new TextEncoder().encode(data)]).stream();
        } else {
            readableStream = new Blob([]).stream();
        }
        
        let crc = 0 ^ (-1);
        let uncompressedSize = 0;
        
        const crcTransform = new TransformStream({
            transform: (chunk, controller) => {
                crc = this.updateCRC32(crc, chunk);
                uncompressedSize += chunk.byteLength;
                controller.enqueue(chunk);
            }
        });

        const compressionMethod = typeof CompressionStream !== 'undefined' ? 8 : 0;
        
        // Write Local File Header with Data Descriptor bit flag
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true); 
        lv.setUint16(4, 20, true);         
        lv.setUint16(6, 0x0808, true);     // UTF-8 | Data Descriptor
        lv.setUint16(8, compressionMethod, true);
        lv.setUint32(10, dosTime, true);   
        lv.setUint32(14, 0, true);         // CRC (unknown)
        lv.setUint32(18, 0, true);         // Compressed Size (unknown)
        lv.setUint32(22, 0, true);         // Uncompressed Size (unknown)
        lv.setUint16(26, nameBytes.length, true); 
        lv.setUint16(28, 0, true);         
        localHeader.set(nameBytes, 30);
        
        const localHeaderOffset = this.offset;
        await this.writeChunk(localHeader);

        let compressedSize = 0;
        const compressionStream = compressionMethod === 8 ? new CompressionStream('deflate-raw') : null;
        
        if (compressionStream) {
            const streamToCompress = readableStream.pipeThrough(crcTransform);
            const reader = streamToCompress.pipeThrough(compressionStream).getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    await this.writeChunk(value);
                    compressedSize += value.byteLength;
                }
            }
        } else {
            const reader = readableStream.pipeThrough(crcTransform).getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    await this.writeChunk(value);
                    compressedSize += value.byteLength;
                }
            }
        }
        
        crc = (crc ^ (-1)) >>> 0;
        
        // Write Data Descriptor (16 bytes)
        const dataDescriptor = new Uint8Array(16);
        const ddv = new DataView(dataDescriptor.buffer);
        ddv.setUint32(0, 0x08074b50, true);
        ddv.setUint32(4, crc, true);
        ddv.setUint32(8, compressedSize, true);
        ddv.setUint32(12, uncompressedSize, true);
        await this.writeChunk(dataDescriptor);

        this.files.push({
            nameBytes,
            crc,
            uncompressedSize,
            compressedSize,
            compressionMethod,
            date,
            dosTime,
            localHeaderOffset
        });
    }

    /**
     * Generate the complete .zip file as a Blob.
     * @returns {Blob}
     */
    async generateBlob() {
        await this.init();
        
        const centralDirOffset = this.offset;
        let centralDirSize = 0;

        for (const file of this.files) {
            const centralHeader = new Uint8Array(46 + file.nameBytes.length);
            const cv = new DataView(centralHeader.buffer);
            cv.setUint32(0, 0x02014b50, true); 
            cv.setUint16(4, 20, true);         
            cv.setUint16(6, 20, true);         
            cv.setUint16(8, 0x0808, true);
            cv.setUint16(10, file.compressionMethod, true);
            cv.setUint32(12, file.dosTime, true);
            cv.setUint32(16, file.crc, true);
            cv.setUint32(20, file.compressedSize, true);
            cv.setUint32(24, file.uncompressedSize, true);
            cv.setUint16(28, file.nameBytes.length, true);
            cv.setUint16(30, 0, true);         
            cv.setUint16(32, 0, true);         
            cv.setUint16(34, 0, true);         
            cv.setUint16(36, 0, true);         
            cv.setUint32(38, 0, true);         
            cv.setUint32(42, file.localHeaderOffset, true);    
            centralHeader.set(file.nameBytes, 46);

            await this.writeChunk(centralHeader);
            centralDirSize += centralHeader.length;
        }

        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);     
        ev.setUint16(4, 0, true);             
        ev.setUint16(6, 0, true);             
        ev.setUint16(8, this.files.length, true); 
        ev.setUint16(10, this.files.length, true); 
        ev.setUint32(12, centralDirSize, true); 
        ev.setUint32(16, centralDirOffset, true); 
        ev.setUint16(20, 0, true);            

        await this.writeChunk(eocd);
        
        await this.opfsWritable.close();
        this.opfsWritable = null;

        const file = await this.opfsFileHandle.getFile();
        
        // Expose a method to clean up OPFS file when done
        file.dispose = async () => {
            try {
                await this.opfsRoot.removeEntry(this.tempFileName);
            } catch (e) {}
        };
        
        return file;
    }

    static toDosDateTime(d) {
        const year = Math.max(1980, d.getFullYear());
        const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        return ((date << 16) | time) >>> 0;
    }
}

if (typeof window !== 'undefined') {
    window.ZipBuilder = ZipBuilder;
}

import mmap, struct, glob, os, sys
names={"411809687":"BoosterCam(FILTERED)","2088557197":"NavCam(FILTERED)",
       "1269908341":"TurretCam(plain)","422400921":"KerbPro#1(plain)","976225514":"KerbPro#2(plain)"}
pid=sys.argv[1]
for p in sorted(glob.glob("/proc/%s/root/run/user/1000/kerbcast/*.ring" % pid)):
    cam=os.path.basename(p).split(".")[0]
    f=open(p,"rb"); m=mmap.mmap(f.fileno(),0,prot=mmap.PROT_READ)
    maxw,maxh=struct.unpack_from("<II",m,16); sb=32+maxw*maxh*4
    wi=struct.unpack_from("<I",m,24)[0]; off=4096+wi*sb
    w,h,stride=struct.unpack_from("<III",m,off); base=off+32
    label=names.get(cam,cam)
    if w==0:
        print("%-22s no frame" % label); continue
    acc={"TL":[0.0,0],"TR":[0.0,0],"BL":[0.0,0],"BR":[0.0,0]}
    for y in range(0,h,4):
        row=base+y*stride
        top = y < h//2
        for x in range(0,w,4):
            o=row+x*4; l=(m[o]+m[o+1]+m[o+2])/3.0
            k=("TL" if x<w//2 else "TR") if top else ("BL" if x<w//2 else "BR")
            acc[k][0]+=l; acc[k][1]+=1
    q=dict((k,v[0]/v[1]) for k,v in acc.items())
    order="".join(sorted(q, key=lambda k:q[k]))
    verdict={"TLTRBLBR":"UPRIGHT","BLBRTLTR":"VERTICAL FLIP",
             "TRTLBRBL":"HORIZONTAL MIRROR","BRBLTRTL":"ROTATED 180"}.get(order,"UNCLEAR(%s)"%order)
    print("%-22s TL=%6.1f TR=%6.1f BL=%6.1f BR=%6.1f  => %s" % (label,q["TL"],q["TR"],q["BL"],q["BR"],verdict))
